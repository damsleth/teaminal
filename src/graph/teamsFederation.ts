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
const DEFAULT_REGION = 'emea'

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

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400)
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
  if (res.status === 404 && /in-tenant/i.test(res.text)) {
    // Teams responds with 404 + "Federated lookup being incorrectly
    // called for in-tenant users." for same-tenant peers. There is
    // nothing federated to resolve here, so signal the caller to bail
    // out of the entire flow.
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
  const res = await requestTeams<unknown>('GET', url, undefined, opts)
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
}
