// Teams chat-service fallback for channel message reads.
//
// Tenants that haven't preauthorized `ChannelMessage.Read.All` on the
// Teams Web app id (9199bf20) cannot read channel messages via Graph -
// the call returns 403 "Missing scope permissions". The Teams web /
// desktop client doesn't use Graph for channel reads either; it talks
// to the regional chat service at:
//
//   GET https://teams.microsoft.com/api/chatsvc/{region}/v1/users/ME
//       /conversations/{threadId}/messages?pageSize=N&startTime=1
//
// authenticated with the same spaces token we already use for
// fetchFederated / msnp24Equivalent. The response is Skype-shaped, so
// we translate each message into the ChannelMessage shape the rest of
// the app already consumes.

import { getToken } from '../auth/owaPiggy'
import { recordRequest } from '../log'
import type { ChatMessage } from '../types'
import { getActiveProfile } from './client'
import { TEAMS_SPACES_SCOPE } from './teamsFederation'

const TEAMS_ORIGIN = 'https://teams.microsoft.com'
const DEFAULT_REGION = 'emea'
const DEFAULT_PAGE_SIZE = 50

export class TeamsChatsvcError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TeamsChatsvcError'
  }
}

export type ChatsvcOpts = {
  profile?: string
  region?: string
  signal?: AbortSignal
}

export type ChatsvcChannelMessagesPage = {
  messages: ChatMessage[]
  /** Skype-style backward link for older messages, or undefined when fully paged. */
  backwardLink?: string
}

type Transport = (url: string, init: RequestInit) => Promise<Response>
const realTransport: Transport = (url, init) => fetch(url, init)
let transport: Transport = realTransport

function region(opts?: ChatsvcOpts): string {
  return opts?.region ?? DEFAULT_REGION
}

function profile(opts?: ChatsvcOpts): string | undefined {
  return opts?.profile ?? getActiveProfile()
}

function chatsvcHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'x-ms-client-type': 'teaminal',
    'x-ms-client-caller': 'teaminal-channel-fallback',
    'x-ms-client-request-type': '0',
    'x-client-ui-language': 'en-us',
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 1024)
  } catch {
    return ''
  }
}

async function chatsvcGet<T>(
  url: string,
  opts?: ChatsvcOpts,
): Promise<{ status: number; body: T | null; text: string }> {
  const token = await getToken({ profile: profile(opts), scope: TEAMS_SPACES_SCOPE })
  const startedAt = Date.now()
  const path = new URL(url).pathname + new URL(url).search
  let res: Response
  try {
    res = await transport(url, {
      method: 'GET',
      headers: chatsvcHeaders(token),
      signal: opts?.signal,
    })
  } catch (err) {
    recordRequest({
      ts: startedAt,
      method: 'GET',
      path,
      status: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  const durationMs = Date.now() - startedAt
  recordRequest({ ts: startedAt, method: 'GET', path, status: res.status, durationMs })
  const text = await safeText(res)
  let parsed: T | null = null
  if (text) {
    try {
      parsed = JSON.parse(text) as T
    } catch {
      parsed = null
    }
  }
  return { status: res.status, body: parsed, text }
}

type SkypeMessage = {
  id?: string
  originalarrivaltime?: string
  composetime?: string
  type?: string
  messagetype?: string
  from?: string
  imdisplayname?: string
  content?: string
  conversationLink?: string
  properties?: {
    edittime?: string | number
    deletetime?: string | number
    parentmessageid?: string
    subject?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

type SkypeMessagesResponse = {
  messages?: SkypeMessage[]
  _metadata?: {
    backwardLink?: string
    syncStateLink?: string
    [key: string]: unknown
  }
}

// Skype "from" values look like
//   https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:UUID
// or sometimes the bare MRI ("8:orgid:UUID"). We extract just the MRI
// suffix and the AAD UUID (when the MRI is an orgid one).
export function parseFrom(from: string | undefined): {
  mri: string | null
  userId: string | null
} {
  if (!from) return { mri: null, userId: null }
  const mri = from.includes('/contacts/') ? from.slice(from.lastIndexOf('/contacts/') + 10) : from
  if (!mri) return { mri: null, userId: null }
  const orgid = mri.match(/^8:orgid:([0-9a-f-]{36})$/i)
  return { mri, userId: orgid ? orgid[1]!.toLowerCase() : null }
}

function toIsoFromAny(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Skype usually expresses these as epoch milliseconds.
    return new Date(value).toISOString()
  }
  if (typeof value === 'string' && value.length > 0) {
    // Numeric string -> epoch ms.
    if (/^\d+$/.test(value)) {
      const n = Number(value)
      if (Number.isFinite(n)) return new Date(n).toISOString()
    }
    // Otherwise assume it's already an ISO 8601 string.
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return new Date(ms).toISOString()
  }
  return undefined
}

const SKYPE_SYSTEM_TYPES = new Set([
  'ThreadActivity/AddMember',
  'ThreadActivity/DeleteMember',
  'ThreadActivity/MemberJoined',
  'ThreadActivity/MemberLeft',
  'ThreadActivity/TopicUpdate',
  'ThreadActivity/PictureUpdate',
  'ThreadActivity/HistoryDisclosedUpdate',
  'Event/Call',
  'Event/Meeting',
])

// Map a Skype-shaped message into the ChannelMessage shape the UI
// already consumes. We only fill fields the renderer actually reads;
// anything missing falls through as undefined. Reactions, attachments,
// and mentions are not yet parsed - they'll show as empty until we
// extend the mapper.
export function skypeToChannelMessage(raw: SkypeMessage): ChatMessage {
  const created =
    toIsoFromAny(raw.originalarrivaltime) ??
    toIsoFromAny(raw.composetime) ??
    new Date(0).toISOString()
  const edited = toIsoFromAny(raw.properties?.edittime)
  const deleted = toIsoFromAny(raw.properties?.deletetime)
  const isHtml = (raw.messagetype ?? '').toLowerCase().includes('html')
  const isSystem = !!raw.messagetype && SKYPE_SYSTEM_TYPES.has(raw.messagetype)
  const { userId } = parseFrom(raw.from)
  const replyToRaw = raw.properties?.parentmessageid
  const replyToId =
    typeof replyToRaw === 'string' && replyToRaw.length > 0 && replyToRaw !== raw.id
      ? replyToRaw
      : undefined

  return {
    id: raw.id ?? '',
    createdDateTime: created,
    ...(edited ? { lastModifiedDateTime: edited } : {}),
    ...(deleted ? { deletedDateTime: deleted } : {}),
    messageType: isSystem ? 'systemEventMessage' : 'message',
    body: {
      contentType: isHtml ? 'html' : 'text',
      content: raw.content ?? '',
    },
    ...(userId || raw.imdisplayname
      ? {
          from: {
            user: {
              id: userId ?? '',
              ...(raw.imdisplayname ? { displayName: raw.imdisplayname } : {}),
            },
          },
        }
      : {}),
    ...(replyToId ? { replyToId } : {}),
    ...(raw.properties?.subject ? { subject: String(raw.properties.subject) } : {}),
  }
}

// Returns root channel messages in chronological order (oldest first),
// to match listChannelMessagesPage in src/graph/teams.ts.
//
// The Skype endpoint returns messages newest-first; we reverse before
// returning so the caller can append in render order. Replies are
// filtered out at the chatsvc layer too (the UI fetches replies via a
// separate path).
export async function listChannelMessagesViaChatsvc(
  threadId: string,
  opts?: ChatsvcOpts & { pageSize?: number },
): Promise<ChatsvcChannelMessagesPage> {
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE
  const url = `${TEAMS_ORIGIN}/api/chatsvc/${region(opts)}/v1/users/ME/conversations/${encodeURIComponent(
    threadId,
  )}/messages?pageSize=${pageSize}&startTime=1&view=msnp24`
  const res = await chatsvcGet<SkypeMessagesResponse>(url, opts)
  if (res.status < 200 || res.status >= 300) {
    throw new TeamsChatsvcError(
      res.status,
      `teams chatsvc messages ${res.status}: ${res.text || 'request failed'}`,
    )
  }
  const raw = res.body?.messages ?? []
  const mapped = raw
    .filter((m) => !m.properties?.parentmessageid || m.properties.parentmessageid === m.id)
    .map(skypeToChannelMessage)
    .filter((m) => m.id.length > 0)
    .reverse()
  return {
    messages: mapped,
    backwardLink: res.body?._metadata?.backwardLink,
  }
}

// Follow a chatsvc backward link returned from a previous page. The
// link Teams returns is already absolute, so we use it verbatim.
export async function listChannelMessagesViaChatsvcNextPage(
  backwardLink: string,
  opts?: ChatsvcOpts,
): Promise<ChatsvcChannelMessagesPage> {
  const res = await chatsvcGet<SkypeMessagesResponse>(backwardLink, opts)
  if (res.status < 200 || res.status >= 300) {
    throw new TeamsChatsvcError(
      res.status,
      `teams chatsvc messages ${res.status}: ${res.text || 'request failed'}`,
    )
  }
  const raw = res.body?.messages ?? []
  const mapped = raw
    .filter((m) => !m.properties?.parentmessageid || m.properties.parentmessageid === m.id)
    .map(skypeToChannelMessage)
    .filter((m) => m.id.length > 0)
    .reverse()
  return {
    messages: mapped,
    backwardLink: res.body?._metadata?.backwardLink,
  }
}

export function __setTransportForTests(t: Transport): void {
  transport = t
}

export function __resetForTests(): void {
  transport = realTransport
}
