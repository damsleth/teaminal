// Teams federated-chat helpers.
//
// Graph can create a 1:1 chat with an AAD user, but the Teams web client
// has an extra resolver path for federated users. The HAR for the
// "Switch chat" warning shows two calls:
//   1. POST /api/mt/part/{region}/beta/users/fetchFederated
//   2. GET  /api/chatsvc/{region}/v1/users/ME/conversations/{id}?view=msnp24Equivalent
//
// We use that second call conservatively before creating a new Graph chat:
// if Teams already knows the canonical equivalent conversation, open it
// instead of creating another detached one.

import { getToken } from '../auth/owaPiggy'
import { recordEvent, recordRequest } from '../log'
import { getActiveProfile } from './client'

export const TEAMS_SPACES_SCOPE = 'https://api.spaces.skype.com/.default'
export const TEAMS_IC3_SCOPE = 'https://ic3.teams.office.com/.default'

const TEAMS_ORIGIN = 'https://teams.microsoft.com'
const TEAMS_AUTHZ_URL = `${TEAMS_ORIGIN}/api/authsvc/v1.0/authz`
const DEFAULT_REGION = 'emea'
const SKYPE_TOKEN_REFRESH_MARGIN_S = 60

export class TeamsFederationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TeamsFederationError'
  }
}

export type TeamsFederationOpts = {
  profile?: string
  region?: string
  signal?: AbortSignal
}

type Transport = (url: string, init: RequestInit) => Promise<Response>
const realTransport: Transport = (url, init) => fetch(url, init)
let transport: Transport = realTransport

// Skype token cache. The chatsvc /v1/users/ME/* endpoints reject the
// raw spaces token (errorCode 911 "Authentication failed") - they want
// the Skype token returned by Teams authsvc. Trouter does the same
// exchange for its WebSocket; we cache the token in-process so chat /
// federation calls share it and don't re-spawn for every request.
type SkypeTokenEntry = { token: string; exp: number }
const skypeTokenCache = new Map<string, SkypeTokenEntry>()
const skypeTokenInFlight = new Map<string, Promise<string>>()

function region(opts?: TeamsFederationOpts): string {
  return opts?.region ?? DEFAULT_REGION
}

function profile(opts?: TeamsFederationOpts): string | undefined {
  return opts?.profile ?? getActiveProfile()
}

function userMriFromOid(oid: string): string {
  return oid.startsWith('8:') ? oid : `8:orgid:${oid}`
}

function oneOnOneUnqConversationId(firstOid: string, secondOid: string): string {
  return `19:${firstOid}_${secondOid}@unq.gbl.spaces`
}

function federationHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json;charset=UTF-8',
    'x-ms-client-type': 'teaminal',
    'x-ms-client-caller': 'chat-with-user-worker-resolver',
    'x-ms-client-request-type': '0',
    'x-ms-migration': 'True',
    'x-ms-test-user': 'False',
    'x-client-ui-language': 'en-us',
  }
}

// Reads the full body. Callers must clip themselves before
// recording / displaying. We previously sliced to 400 chars here for
// log safety, but that silently truncated valid JSON whenever a
// chatsvc/messages response exceeded the clip - JSON.parse would fail
// and the caller would see "no usable messages" on a successful 200.
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

async function requestTeams<T>(
  method: 'GET' | 'POST',
  url: string,
  body: unknown | undefined,
  opts?: TeamsFederationOpts & { scope?: string },
): Promise<{ status: number; body: T | null; text: string }> {
  const token = await getToken({ profile: profile(opts), scope: opts?.scope ?? TEAMS_SPACES_SCOPE })
  const startedAt = Date.now()
  const path = new URL(url).pathname + new URL(url).search
  let res: Response
  try {
    res = await transport(url, {
      method,
      headers: federationHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts?.signal,
    })
  } catch (err) {
    recordRequest({
      ts: startedAt,
      method,
      path,
      status: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  const durationMs = Date.now() - startedAt
  recordRequest({ ts: startedAt, method, path, status: res.status, durationMs })
  const fullText = await safeText(res)
  let parsed: T | null = null
  if (fullText) {
    try {
      parsed = JSON.parse(fullText) as T
    } catch {
      parsed = null
    }
  }
  return { status: res.status, body: parsed, text: fullText.slice(0, 1024) }
}

type SkypeTokenResponse = {
  token: string
  expiresIn?: number
}

// Authsvc returns the skype token under several layouts depending on
// region / experiment: top-level `skypeToken`, top-level `tokens`, or
// nested under `tokens.skypeToken`. Try every shape we've observed.
function pickSkypeToken(data: unknown): SkypeTokenResponse | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  const candidates: unknown[] = [
    obj.skypeToken,
    obj.tokens,
    (obj.tokens as Record<string, unknown> | undefined)?.skypeToken,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return { token: c }
    if (c && typeof c === 'object') {
      const t = (c as Record<string, unknown>).skypeToken ?? (c as Record<string, unknown>).token
      if (typeof t === 'string' && t.length > 0) {
        const expRaw = (c as Record<string, unknown>).expiresIn
        const exp = typeof expRaw === 'number' && Number.isFinite(expRaw) ? expRaw : undefined
        return { token: t, ...(exp !== undefined ? { expiresIn: exp } : {}) }
      }
    }
  }
  return null
}

function skypeCacheKey(opts?: TeamsFederationOpts): string {
  return profile(opts) ?? '<default>'
}

async function postAuthz(bearerToken: string, signal?: AbortSignal): Promise<Response> {
  const startedAt = Date.now()
  let res: Response
  try {
    res = await transport(TEAMS_AUTHZ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
      signal,
    })
  } catch (err) {
    recordRequest({
      ts: startedAt,
      method: 'POST',
      path: '/api/authsvc/v1.0/authz',
      status: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  recordRequest({
    ts: startedAt,
    method: 'POST',
    path: '/api/authsvc/v1.0/authz',
    status: res.status,
    durationMs: Date.now() - startedAt,
  })
  return res
}

export async function getSkypeToken(opts?: TeamsFederationOpts): Promise<string> {
  const key = skypeCacheKey(opts)
  const now = Date.now() / 1000
  const cached = skypeTokenCache.get(key)
  if (cached && cached.exp - now > SKYPE_TOKEN_REFRESH_MARGIN_S) {
    return cached.token
  }
  const existing = skypeTokenInFlight.get(key)
  if (existing) return existing
  const promise = (async () => {
    // The authsvc endpoint wants a Teams-audience token, not the
    // default Graph token. Try that scope first; owa-piggy's scope
    // fallback will quietly downgrade to the default Graph audience
    // if the tenant has not preauthorized teams.microsoft.com.
    const teamsAudienceToken = await getToken({
      profile: profile(opts),
      scope: 'https://teams.microsoft.com/.default',
    })
    let res = await postAuthz(teamsAudienceToken, opts?.signal)
    if (res.status === 401) {
      // Some tenants accept the spaces-scoped token at authsvc instead.
      // Try that before giving up.
      const spacesToken = await getToken({
        profile: profile(opts),
        scope: TEAMS_SPACES_SCOPE,
      })
      if (spacesToken !== teamsAudienceToken) {
        res = await postAuthz(spacesToken, opts?.signal)
      }
    }
    if (!res.ok) {
      const text = await safeText(res)
      const challenge = res.headers.get('www-authenticate') ?? ''
      const correlation =
        res.headers.get('x-ms-correlation-id') ?? res.headers.get('request-id') ?? ''
      const aadCode = text.match(/AADSTS\d{4,}/)?.[0] ?? ''
      // Surface the diagnostics trouter already records, so the network
      // panel shows *why* authsvc refused us instead of "request failed".
      recordEvent('graph', 'warn', `teams authz ${res.status} ${res.statusText || ''}`)
      if (aadCode) recordEvent('graph', 'warn', `teams authz aadcode ${aadCode}`)
      if (challenge) {
        recordEvent('graph', 'warn', `teams authz challenge ${challenge.slice(0, 240)}`)
      }
      if (correlation) recordEvent('graph', 'warn', `teams authz corr ${correlation}`)
      if (text) {
        recordEvent('graph', 'warn', `teams authz body ${text.slice(0, 240).replace(/\s+/g, ' ')}`)
      }
      throw new TeamsFederationError(
        res.status,
        `teams authz ${res.status}: ${aadCode || text || 'request failed'}`,
      )
    }
    const raw = (await res.json().catch(() => ({}))) as unknown
    const skype = pickSkypeToken(raw)
    if (!skype) {
      throw new TeamsFederationError(res.status, 'teams authz: skype token missing from response')
    }
    skypeTokenCache.set(key, {
      token: skype.token,
      exp: Date.now() / 1000 + (skype.expiresIn ?? 3600),
    })
    return skype.token
  })()
  skypeTokenInFlight.set(key, promise)
  try {
    return await promise
  } finally {
    skypeTokenInFlight.delete(key)
  }
}

function chatsvcMeHeaders(skypeToken: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json;charset=UTF-8',
    Authentication: `skypetoken=${skypeToken}`,
    'x-skypetoken': skypeToken,
    'x-ms-client-type': 'teaminal',
    'x-ms-client-caller': 'teaminal',
    'x-ms-client-request-type': '0',
    'x-client-ui-language': 'en-us',
  }
}

// chatsvc /v1/users/ME/* endpoints want the Skype token, not the
// spaces token. Caller passes the full URL (including region) and
// receives the parsed body alongside the raw status / text for
// downstream error handling.
export async function requestChatsvcMe<T>(
  method: 'GET' | 'POST',
  url: string,
  body: unknown | undefined,
  opts?: TeamsFederationOpts,
): Promise<{ status: number; body: T | null; text: string }> {
  const token = await getSkypeToken(opts)
  const startedAt = Date.now()
  const path = new URL(url).pathname + new URL(url).search
  let res: Response
  try {
    res = await transport(url, {
      method,
      headers: chatsvcMeHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts?.signal,
    })
  } catch (err) {
    recordRequest({
      ts: startedAt,
      method,
      path,
      status: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  const durationMs = Date.now() - startedAt
  recordRequest({ ts: startedAt, method, path, status: res.status, durationMs })
  const fullText = await safeText(res)
  let parsed: T | null = null
  if (fullText) {
    try {
      parsed = JSON.parse(fullText) as T
    } catch {
      parsed = null
    }
  }
  return { status: res.status, body: parsed, text: fullText.slice(0, 1024) }
}

export class TeamsInTenantLookupError extends TeamsFederationError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'TeamsInTenantLookupError'
  }
}

export async function fetchFederatedUsers(
  userOids: string[],
  opts?: TeamsFederationOpts,
): Promise<unknown[]> {
  if (userOids.length === 0) return []
  const url = `${TEAMS_ORIGIN}/api/mt/part/${region(opts)}/beta/users/fetchFederated?edEnabled=false&includeDisabledAccounts=true`
  const mris = userOids.map(userMriFromOid)
  const res = await requestTeams<unknown[]>('POST', url, mris, opts)
  if (res.status === 404) {
    // Teams responds with 404 (sometimes "Federated lookup being
    // incorrectly called for in-tenant users", sometimes a generic
    // "An unexpected error(Type = NotFound) occurred") for same-tenant
    // peers. Either way there is nothing federated to resolve, so
    // signal the caller to bail out of the entire flow rather than
    // banging on the chatsvc endpoints with the wrong audience.
    throw new TeamsInTenantLookupError(res.status, 'in-tenant user, federated lookup not applicable')
  }
  if (res.status < 200 || res.status >= 300) {
    throw new TeamsFederationError(
      res.status,
      `teams fetchFederated ${res.status}: ${res.text || 'request failed'}`,
    )
  }
  return Array.isArray(res.body) ? res.body : []
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function orgidOidFromString(value: string): string[] {
  const out: string[] = []
  for (const match of value.matchAll(/8:orgid:([0-9a-f-]{36})/gi)) {
    out.push(match[1]!.toLowerCase())
  }
  return out
}

export function federatedUserOids(value: unknown): string[] {
  const out: string[] = []
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      out.push(...orgidOidFromString(current))
      return
    }
    if (!current || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }
    const obj = current as Record<string, unknown>
    for (const key of ['mri', 'id', 'userId', 'objectId', 'aadObjectId', 'aadId']) {
      const value = obj[key]
      if (typeof value === 'string') {
        if (/^[0-9a-f-]{36}$/i.test(value)) out.push(value.toLowerCase())
        out.push(...orgidOidFromString(value))
      }
    }
    for (const nested of Object.values(obj)) visit(nested)
  }
  visit(value)
  return unique(out)
}

function findConversationId(value: unknown): string | null {
  if (typeof value === 'string') {
    if (/^(19:|8:|48:)/.test(value)) return value
    return null
  }
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  for (const key of ['id', 'conversationId', 'threadId']) {
    const found = findConversationId(obj[key])
    if (found) return found
  }
  for (const nested of Object.values(obj)) {
    const found = findConversationId(nested)
    if (found) return found
  }
  return null
}

export async function getMsnp24EquivalentConversationId(
  conversationId: string,
  opts?: TeamsFederationOpts,
): Promise<string | null> {
  const url = `${TEAMS_ORIGIN}/api/chatsvc/${region(opts)}/v1/users/ME/conversations/${encodeURIComponent(
    conversationId,
  )}?view=msnp24Equivalent`
  const res = await requestChatsvcMe<unknown>('GET', url, undefined, opts)
  if (res.status === 404) return null
  if (res.status < 200 || res.status >= 300) {
    throw new TeamsFederationError(
      res.status,
      `teams msnp24Equivalent ${res.status}: ${res.text || 'request failed'}`,
    )
  }
  return findConversationId(res.body)
}

export async function conversationExistsInTeams(
  conversationId: string,
  opts?: TeamsFederationOpts,
): Promise<boolean> {
  const url = `${TEAMS_ORIGIN}/api/chatsvc/${region(opts)}/v1/threads/${encodeURIComponent(
    conversationId,
  )}/consumptionhorizons`
  const res = await requestTeams<unknown>('GET', url, undefined, {
    ...opts,
    scope: TEAMS_IC3_SCOPE,
  })
  if (res.status === 404) return false
  if (res.status < 200 || res.status >= 300) {
    throw new TeamsFederationError(
      res.status,
      `teams consumptionhorizons ${res.status}: ${res.text || 'request failed'}`,
    )
  }
  return true
}

export async function resolveFederatedEquivalentConversationId(
  selfUserId: string,
  otherUserId: string,
  opts?: TeamsFederationOpts,
): Promise<string | null> {
  let federatedOids: string[] = []
  try {
    federatedOids = federatedUserOids(await fetchFederatedUsers([otherUserId], opts)).filter(
      (oid) => oid !== selfUserId,
    )
  } catch (err) {
    if (err instanceof TeamsInTenantLookupError) {
      // Same-tenant peer: nothing federated to resolve. Skip the
      // chatsvc probes (they 401 on in-tenant ids and add noise).
      return null
    }
    recordEvent(
      'graph',
      'debug',
      `federated profile lookup skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const remoteOids = unique([...federatedOids, otherUserId])
  const candidates = remoteOids.flatMap((oid) => [
    oneOnOneUnqConversationId(oid, selfUserId),
    oneOnOneUnqConversationId(selfUserId, oid),
  ])
  for (const candidate of candidates) {
    if (await conversationExistsInTeams(candidate, opts)) return candidate
    const equivalent = await getMsnp24EquivalentConversationId(candidate, opts)
    if (equivalent && equivalent !== candidate) return equivalent
  }
  return null
}

export function __setTransportForTests(t: Transport): void {
  transport = t
}

export function __resetForTests(): void {
  transport = realTransport
  skypeTokenCache.clear()
  skypeTokenInFlight.clear()
}
