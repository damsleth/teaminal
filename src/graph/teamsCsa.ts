// Teams chat-service aggregator (CSA): chat + teams list.
//
// Replaces the graph `/chats` + `/me/joinedTeams` calls (which are
// Conditional-Access-gated in some tenants) with the endpoints the Teams
// web client uses. Two calls, because they carry different data:
//
//   Chats (1:1 / group / meeting), WITH member display names + paging:
//     GET .../api/csa/{region}/api/v2/teams/users/me/chats?pageSize=N
//       → { items: [chat...], continuationToken }
//
//   Teams + channels (bootstrap):
//     GET .../api/csa/{region}/api/v1/teams/users/me
//       → { teams: [...channels...], chats: [...], privateFeeds, metadata }
//     (NOTE: the bootstrap's chats[] members have NO displayName — verified
//      against a live tenant — so we take chats from the v2 endpoint and
//      use the bootstrap only for teams/channels.)
//
// Auth: csa Bearer (aud=chatsvcagg.teams.microsoft.com), see csaAuth.ts.
//
// Response shapes verified against a live tenant probe (.tmp/csa_*.json).
// Parsing is defensive: unknown / missing fields degrade to sensible
// defaults rather than throwing, since CSA evolves.

import { recordEvent, recordRequest } from '../log'
import type { Channel, Chat, ChatMember, ChatType, LastMessagePreview, Team } from '../types'
import { getActiveProfile } from './client'
import { csaHeaders, getCsaToken, withCsaAuth } from './csaAuth'
import { resolveRegion, TEAMS_ORIGIN } from './teamsRegion'

export class TeamsCsaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TeamsCsaError'
  }
}

export type CsaOpts = {
  profile?: string
  region?: string
  signal?: AbortSignal
}

export type ChatsAndTeams = {
  chats: Chat[]
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
}

type Transport = (url: string, init: RequestInit) => Promise<Response>
const realTransport: Transport = (url, init) => fetch(url, init)
let transport: Transport = realTransport

async function region(opts?: CsaOpts): Promise<string> {
  if (opts?.region) return opts.region
  return resolveRegion({ profile: opts?.profile, signal: opts?.signal })
}

function profile(opts?: CsaOpts): string | undefined {
  return opts?.profile ?? getActiveProfile()
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

// --- wire shapes (only the fields we map) ---

type CsaMember = {
  mri?: string
  objectId?: string
  displayName?: string
  email?: string
  role?: string
  userPrincipalName?: string
}

type CsaLastMessage = {
  id?: string
  messageType?: string
  content?: string
  composeTime?: string
  originalArrivalTime?: string
  from?: string
  imDisplayName?: string
  fromDisplayNameInToken?: string
}

type CsaChat = {
  id?: string
  title?: string | null
  threadType?: string
  chatType?: string
  isOneOnOne?: boolean
  createdAt?: string
  members?: CsaMember[]
  lastMessage?: CsaLastMessage | null
}

type CsaChannel = {
  id?: string
  displayName?: string
  description?: string | null
}

type CsaTeam = {
  id?: string
  displayName?: string
  description?: string | null
  channels?: CsaChannel[]
}

type CsaBootstrapResponse = {
  teams?: CsaTeam[]
  chats?: CsaChat[]
}

type CsaChatsPageResponse = {
  items?: CsaChat[]
  continuationToken?: string | null
}

// Safety cap on chat pages so an account with thousands of conversations
// doesn't paginate forever on first load.
const MAX_CHAT_PAGES = 10
const DEFAULT_CHAT_PAGE_SIZE = 50

// --- mappers ---

// Extract the AAD UUID from an MRI like `8:orgid:UUID`; pass other MRIs
// (consumer / interop) through unchanged.
function userIdFromMri(mri: string | undefined): string | undefined {
  if (!mri) return undefined
  const m = mri.match(/^8:orgid:([0-9a-f-]{36})$/i)
  return m ? m[1]!.toLowerCase() : mri
}

export function mapCsaMember(m: CsaMember): ChatMember {
  const id = m.mri ?? m.objectId ?? ''
  return {
    id,
    ...(m.displayName ? { displayName: m.displayName } : {}),
    ...(m.email ? { email: m.email } : {}),
    ...(m.objectId ? { userId: m.objectId.toLowerCase() } : { userId: userIdFromMri(m.mri) ?? null }),
    ...(m.role ? { roles: [m.role] } : {}),
  }
}

function mapLastMessage(lm: CsaLastMessage | null | undefined): LastMessagePreview | undefined {
  if (!lm || !lm.id) return undefined
  const created = lm.originalArrivalTime ?? lm.composeTime
  const isHtml = (lm.messageType ?? '').toLowerCase().includes('html')
  const fromId = userIdFromMri(lm.from)
  const fromName = lm.imDisplayName ?? lm.fromDisplayNameInToken
  return {
    id: lm.id,
    createdDateTime: created ?? new Date(0).toISOString(),
    ...(lm.messageType ? { messageType: lm.messageType } : {}),
    body: {
      contentType: isHtml ? 'html' : 'text',
      content: lm.content ?? '',
    },
    ...(fromId || fromName
      ? { from: { user: { id: fromId ?? '', ...(fromName ? { displayName: fromName } : {}) } } }
      : {}),
  }
}

function csaChatType(c: CsaChat): ChatType {
  if (c.isOneOnOne === true) return 'oneOnOne'
  const t = `${c.threadType ?? ''} ${c.chatType ?? ''}`.toLowerCase()
  if (t.includes('meeting')) return 'meeting'
  if (t.includes('space') || t.includes('topic') || c.title) return 'group'
  return 'group'
}

export function mapCsaChat(c: CsaChat): Chat | null {
  if (!c.id) return null
  const members = Array.isArray(c.members) ? c.members.map(mapCsaMember) : undefined
  const preview = mapLastMessage(c.lastMessage)
  return {
    id: c.id,
    ...(c.title ? { topic: c.title } : {}),
    createdDateTime: c.createdAt ?? new Date(0).toISOString(),
    chatType: csaChatType(c),
    ...(members ? { members } : {}),
    ...(preview ? { lastMessagePreview: preview } : {}),
  }
}

export function mapCsaTeam(t: CsaTeam): { team: Team; channels: Channel[] } | null {
  if (!t.id) return null
  const team: Team = {
    id: t.id,
    displayName: t.displayName ?? '(unnamed team)',
    ...(t.description ? { description: t.description } : {}),
  }
  const channels: Channel[] = Array.isArray(t.channels)
    ? t.channels
        .filter((ch): ch is CsaChannel & { id: string } => typeof ch.id === 'string')
        .map((ch) => ({
          id: ch.id,
          displayName: ch.displayName ?? '(unnamed channel)',
          ...(ch.description ? { description: ch.description } : {}),
        }))
    : []
  return { team, channels }
}

export function parseChatsPage(body: unknown): { chats: Chat[]; continuationToken?: string } {
  const obj = (body ?? {}) as CsaChatsPageResponse
  const chats: Chat[] = []
  for (const c of Array.isArray(obj.items) ? obj.items : []) {
    const mapped = mapCsaChat(c)
    if (mapped) chats.push(mapped)
  }
  return {
    chats,
    ...(obj.continuationToken ? { continuationToken: obj.continuationToken } : {}),
  }
}

export function parseTeamsBootstrap(body: unknown): {
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
} {
  const obj = (body ?? {}) as CsaBootstrapResponse
  const teams: Team[] = []
  const channelsByTeam: Record<string, Channel[]> = {}
  for (const t of Array.isArray(obj.teams) ? obj.teams : []) {
    const mapped = mapCsaTeam(t)
    if (!mapped) continue
    teams.push(mapped.team)
    channelsByTeam[mapped.team.id] = mapped.channels
  }
  return { teams, channelsByTeam }
}

async function csaGet(path: string, opts: CsaOpts | undefined, diagPath: string): Promise<unknown> {
  const token = await getCsaToken(profile(opts))
  const startedAt = Date.now()
  let res: Response
  try {
    res = await transport(path, {
      method: 'GET',
      headers: csaHeaders(token),
      signal: opts?.signal,
    })
  } catch (err) {
    recordRequest({
      ts: startedAt,
      method: 'GET',
      path: diagPath,
      status: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  recordRequest({
    ts: startedAt,
    method: 'GET',
    path: diagPath,
    status: res.status,
    durationMs: Date.now() - startedAt,
  })
  const text = await safeText(res)
  if (res.status < 200 || res.status >= 300) {
    throw new TeamsCsaError(
      res.status,
      `teams csa ${diagPath} ${res.status}: ${text.slice(0, 240) || 'request failed'}`,
    )
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Fetch the chat list (with member display names) from the v2 endpoint,
// following continuationToken up to MAX_CHAT_PAGES.
export async function fetchChats(opts?: CsaOpts & { pageSize?: number }): Promise<Chat[]> {
  return withCsaAuth(async () => {
    const r = await region(opts)
    const pageSize = opts?.pageSize ?? DEFAULT_CHAT_PAGE_SIZE
    const base = `${TEAMS_ORIGIN}/api/csa/${r}/api/v2/teams/users/me/chats`
    const all: Chat[] = []
    let token: string | undefined
    for (let page = 0; page < MAX_CHAT_PAGES; page++) {
      const params = new URLSearchParams({ pageSize: String(pageSize), isPrefetch: 'false' })
      if (token) params.set('continuationToken', token)
      const body = await csaGet(`${base}?${params.toString()}`, opts, '/api/csa/.../me/chats')
      const { chats, continuationToken } = parseChatsPage(body)
      all.push(...chats)
      if (!continuationToken || chats.length === 0) break
      token = continuationToken
    }
    return all
  }, profile(opts))
}

// Fetch teams + channels from the v1 bootstrap.
export async function fetchTeams(
  opts?: CsaOpts,
): Promise<{ teams: Team[]; channelsByTeam: Record<string, Channel[]> }> {
  return withCsaAuth(async () => {
    const r = await region(opts)
    const body = await csaGet(
      `${TEAMS_ORIGIN}/api/csa/${r}/api/v1/teams/users/me`,
      opts,
      '/api/csa/.../teams/users/me',
    )
    return parseTeamsBootstrap(body)
  }, profile(opts))
}

// Combined chat + teams list (chats from v2, teams from the bootstrap).
export async function fetchChatsAndTeams(opts?: CsaOpts): Promise<ChatsAndTeams> {
  const [chats, teamsResult] = await Promise.all([fetchChats(opts), fetchTeams(opts)])
  recordEvent(
    'graph',
    'debug',
    `csa chatsAndTeams: ${chats.length} chats, ${teamsResult.teams.length} teams`,
  )
  return { chats, teams: teamsResult.teams, channelsByTeam: teamsResult.channelsByTeam }
}

export function __setTransportForTests(t: Transport): void {
  transport = t
}

export function __resetForTests(): void {
  transport = realTransport
}
