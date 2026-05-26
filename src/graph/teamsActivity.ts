// CSA (Chat Service Aggregator) activity feed.
//
// Hits the same endpoint the Teams web client uses for its bell-icon
// Activity panel:
//
//   GET https://teams.microsoft.com/api/csa/{region}/api/v3/teams/users/me/updates
//
// Returns an aggregated, server-ranked list of @mentions, replies,
// reactions, follow-channel posts, missed calls, and "added to team"
// events spanning every chat and channel the user belongs to. The
// shape is loosely typed and changes occasionally — we parse defensively
// and skip activity items we don't recognize rather than throwing.
//
// Auth: x-skypetoken (same as chatsvc). Regional prefix comes from
// teamsRegion. Pagination uses opaque `_metadata.syncState` blobs —
// callers pass them back verbatim on the next request.
//
// 401s flow through withSkypeAuth so a stale cache hit doesn't kill the
// hydration.

import { recordEvent, recordRequest } from '../log'
import { getActiveProfile } from './client'
import { csaHeaders, getCsaToken, withCsaAuth } from './csaAuth'
import { resolveRegion, TEAMS_ORIGIN } from './teamsRegion'

export class TeamsActivityError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TeamsActivityError'
  }
}

export type ActivityKind =
  | 'mention'
  | 'reply'
  | 'reaction'
  | 'follow-post'
  | 'missed-call'
  | 'team-added'
  | 'unknown'

export type ActivityItem = {
  /** Stable id Teams assigns to each activity; survives sync. */
  id: string
  kind: ActivityKind
  /** Activity type as Teams labels it on the wire. */
  rawActivityType?: string
  /** Conversation the activity points at, when one is encoded. */
  chatId?: string | undefined
  /** Source message id, when present. */
  messageId?: string | undefined
  /** Originating user id (8:orgid:UUID → UUID lowercased) when present. */
  senderId?: string | undefined
  /** Display name the server attached, when present. */
  senderDisplayName?: string | undefined
  /** Single-line preview, HTML stripped. */
  preview?: string | undefined
  /** ISO timestamp of the activity. */
  createdAt: string
  /** Whether the user has acked / read this entry server-side. */
  isRead: boolean
}

export type ActivityPage = {
  items: ActivityItem[]
  /** Opaque cursor for the next /updates call. Empty when fully paged. */
  syncState?: string
}

export type ActivityOpts = {
  profile?: string
  region?: string
  signal?: AbortSignal
  /** Set to true on the very first poll of the session; matches what Teams web sends. */
  isPrefetch?: boolean
  /** When set, requests the next page using a previously-returned syncState. */
  syncState?: string
}

type Transport = (url: string, init: RequestInit) => Promise<Response>
const realTransport: Transport = (url, init) => fetch(url, init)
let transport: Transport = realTransport

async function region(opts?: ActivityOpts): Promise<string> {
  if (opts?.region) return opts.region
  return resolveRegion({ profile: opts?.profile, signal: opts?.signal })
}

function profile(opts?: ActivityOpts): string | undefined {
  return opts?.profile ?? getActiveProfile()
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

const ACTIVITY_KIND_MAP: Record<string, ActivityKind> = {
  // Subset of types observed in Teams web HARs; unknown values fall
  // through to 'unknown' so we don't drop them entirely.
  mention: 'mention',
  atmention: 'mention',
  channelmention: 'mention',
  groupmention: 'mention',
  reply: 'reply',
  replytomyself: 'reply',
  replyinathread: 'reply',
  reaction: 'reaction',
  emoji: 'reaction',
  followedchannelpost: 'follow-post',
  follow_post: 'follow-post',
  follow: 'follow-post',
  missedcall: 'missed-call',
  call: 'missed-call',
  teamadded: 'team-added',
  addedtoteam: 'team-added',
}

export function classifyActivityType(raw: string | undefined): ActivityKind {
  if (!raw) return 'unknown'
  const key = raw.toLowerCase().replace(/[\s_-]+/g, '')
  return ACTIVITY_KIND_MAP[key] ?? 'unknown'
}

function extractUserId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const orgid = value.match(/8:orgid:([0-9a-f-]{36})/i)
  if (orgid) return orgid[1]!.toLowerCase()
  if (/^[0-9a-f-]{36}$/i.test(value)) return value.toLowerCase()
  return undefined
}

// CSA returns conversation IDs in a couple of shapes — sometimes as the
// canonical 19:...@thread.* string, sometimes nested under
// `conversationLink`. Pull whichever is present.
function extractChatId(raw: Record<string, unknown>): string | undefined {
  const direct = raw.conversationId ?? raw.chatId ?? raw.threadId
  if (typeof direct === 'string' && /^(19:|8:|48:)/.test(direct)) return direct
  const link = raw.conversationLink
  if (typeof link === 'string') {
    const m = link.match(/conversations\/([^/?#]+)/)
    if (m) return decodeURIComponent(m[1]!)
  }
  return undefined
}

function stripHtml(input: string | undefined): string | undefined {
  if (!input) return undefined
  const stripped = input
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length > 0 ? stripped : undefined
}

export function parseActivityItem(raw: unknown): ActivityItem | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const id =
    (typeof obj.id === 'string' && obj.id) ||
    (typeof obj.activityId === 'string' && obj.activityId) ||
    (typeof obj.feedId === 'string' && obj.feedId) ||
    null
  if (!id) return null
  const rawType =
    typeof obj.activityType === 'string'
      ? obj.activityType
      : typeof obj.type === 'string'
        ? obj.type
        : undefined
  const kind = classifyActivityType(rawType)
  const ts =
    typeof obj.activityTimestamp === 'string'
      ? obj.activityTimestamp
      : typeof obj.composedTime === 'string'
        ? obj.composedTime
        : typeof obj.timestamp === 'string'
          ? obj.timestamp
          : undefined
  const createdAt = ts ?? new Date(0).toISOString()
  const sourceUser = obj.sourceUserImDisplayName ?? obj.sourceUser ?? obj.imdisplayname
  const senderDisplayName = typeof sourceUser === 'string' ? sourceUser : undefined
  const senderId = extractUserId(obj.sourceUserMri ?? obj.sourceUser ?? obj.fromUser ?? obj.from)
  const previewSource =
    typeof obj.messagePreview === 'string'
      ? obj.messagePreview
      : typeof obj.preview === 'string'
        ? obj.preview
        : typeof obj.content === 'string'
          ? obj.content
          : undefined
  const item: ActivityItem = {
    id,
    kind,
    rawActivityType: rawType,
    chatId: extractChatId(obj),
    messageId:
      typeof obj.messageId === 'string'
        ? obj.messageId
        : typeof obj.itemId === 'string'
          ? obj.itemId
          : undefined,
    senderId,
    senderDisplayName,
    preview: stripHtml(previewSource),
    createdAt,
    isRead: parseReadFlag(obj),
  }
  return item
}

// CSA encodes read-state under a few keys and value types across regions:
// boolean `isRead`/`read`, a numeric 1/0, or a string `readState:"read"`.
// Treat any of those truthy forms as read so the unread badge doesn't
// perpetually show mentions the user already cleared in the web client.
function parseReadFlag(obj: Record<string, unknown>): boolean {
  for (const key of ['isRead', 'read', 'isSeen', 'seen']) {
    const v = obj[key]
    if (v === true || v === 1) return true
    if (typeof v === 'string' && /^(true|read|seen|1)$/i.test(v)) return true
  }
  const state = obj.readState ?? obj.activityState
  if (typeof state === 'string' && /^(read|seen)$/i.test(state)) return true
  return false
}

type CsaUpdatesResponse = {
  value?: unknown
  items?: unknown
  activities?: unknown
  _metadata?: { syncState?: unknown; syncToken?: unknown }
}

function extractItemsArray(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return []
  const obj = body as CsaUpdatesResponse
  for (const candidate of [obj.value, obj.items, obj.activities]) {
    if (Array.isArray(candidate)) return candidate as unknown[]
  }
  return []
}

export async function listActivityFeed(opts?: ActivityOpts): Promise<ActivityPage> {
  return withCsaAuth(async () => {
    const r = await region(opts)
    const params = new URLSearchParams({
      isPrefetch: String(opts?.isPrefetch === true),
      enableMembershipSummary: 'true',
      migratePinnedToFavorites: 'false',
      supportsAdditionalSystemGeneratedFolders: 'true',
      supportsSliceItems: 'true',
      enableEngageCommunities: 'false',
    })
    if (opts?.syncState) params.set('syncState', opts.syncState)
    const url = `${TEAMS_ORIGIN}/api/csa/${r}/api/v3/teams/users/me/updates?${params.toString()}`
    const token = await getCsaToken(profile(opts))
    const startedAt = Date.now()
    let res: Response
    try {
      res = await transport(url, {
        method: 'GET',
        headers: csaHeaders(token),
        signal: opts?.signal,
      })
    } catch (err) {
      recordRequest({
        ts: startedAt,
        method: 'GET',
        path: '/api/csa/.../updates',
        status: null,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
    recordRequest({
      ts: startedAt,
      method: 'GET',
      path: '/api/csa/.../updates',
      status: res.status,
      durationMs: Date.now() - startedAt,
    })
    const text = await safeText(res)
    if (res.status < 200 || res.status >= 300) {
      throw new TeamsActivityError(
        res.status,
        `teams csa updates ${res.status}: ${text.slice(0, 240) || 'request failed'}`,
      )
    }
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }
    const raw = extractItemsArray(parsed)
    const items: ActivityItem[] = []
    for (const r of raw) {
      const item = parseActivityItem(r)
      if (item) items.push(item)
    }
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    const metaRaw =
      parsed && typeof parsed === 'object' ? ((parsed as CsaUpdatesResponse)._metadata ?? {}) : {}
    const syncToken =
      typeof metaRaw.syncState === 'string'
        ? metaRaw.syncState
        : typeof metaRaw.syncToken === 'string'
          ? metaRaw.syncToken
          : undefined
    recordEvent(
      'graph',
      'debug',
      `csa updates: ${items.length} items, syncState=${syncToken ? 'set' : 'none'}`,
    )
    return {
      items,
      ...(syncToken ? { syncState: syncToken } : {}),
    }
  }, profile(opts))
}

export function __setTransportForTests(t: Transport): void {
  transport = t
}

export function __resetForTests(): void {
  transport = realTransport
}
