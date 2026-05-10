// External user search via the Teams chatsvc-side `searchUsers`
// endpoint.
//
// Microsoft Graph's people / users search only surfaces in-tenant and
// B2B-linked users. To start a chat with someone in a fully external
// tenant (no B2B trust), we have to walk the federated identity graph
// the same way Teams web does:
//
//   GET https://teams.microsoft.com/api/mt/{region}/beta/users/searchUsers
//        ?searchTerm=<email>
//
// Authenticated with the Skype token already used for chatsvc message
// reads. Response is Skype-shaped; we map each entry into the existing
// DirectoryUser shape so callers only deal with one type.
//
// See docs/external-user-search.md for the full design rationale.

import { getToken } from '../auth/owaPiggy'
import { recordEvent, recordRequest } from '../log'
import type { DirectoryUser } from '../types'
import { getActiveProfile } from './client'
import { TEAMS_SPACES_SCOPE } from './teamsFederation'

const TEAMS_ORIGIN = 'https://teams.microsoft.com'
const DEFAULT_REGION = 'emea'

export class TeamsExternalSearchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TeamsExternalSearchError'
  }
}

export type ExternalSearchOpts = {
  profile?: string
  region?: string
  signal?: AbortSignal
  /** Hard cap on the number of results returned to the caller. */
  top?: number
}

type Transport = (url: string, init: RequestInit) => Promise<Response>
const realTransport: Transport = (url, init) => fetch(url, init)
let transport: Transport = realTransport

function region(opts?: ExternalSearchOpts): string {
  return opts?.region ?? DEFAULT_REGION
}

function profile(opts?: ExternalSearchOpts): string | undefined {
  return opts?.profile ?? getActiveProfile()
}

// /api/mt/* endpoints (fetchFederated, searchUsers) use the Teams
// "spaces" token via Authorization: Bearer - the same shape
// fetchFederated already uses. The chatsvc /v1/users/ME/* endpoints
// are the ones that want the Skype token via Authentication; do not
// confuse them.
function searchHeaders(spacesToken: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${spacesToken}`,
    'x-ms-client-type': 'teaminal',
    'x-ms-client-caller': 'teaminal-external-search',
    'x-ms-client-request-type': '0',
    'x-client-ui-language': 'en-us',
  }
}

async function safeFullText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

// Skype `searchUsers` rows. Multiple shapes have been observed in the
// wild; we cover the union.
type SkypeSearchUser = {
  mri?: string
  displayName?: string
  email?: string
  userPrincipalName?: string
  upn?: string
  tenantId?: string
  type?: string
  [key: string]: unknown
}

type SkypeSearchResponse =
  | SkypeSearchUser[]
  | { value?: SkypeSearchUser[]; users?: SkypeSearchUser[]; [key: string]: unknown }

function extractRows(body: unknown): SkypeSearchUser[] {
  if (!body) return []
  if (Array.isArray(body)) return body as SkypeSearchUser[]
  if (typeof body === 'object') {
    const obj = body as { value?: unknown; users?: unknown }
    if (Array.isArray(obj.value)) return obj.value as SkypeSearchUser[]
    if (Array.isArray(obj.users)) return obj.users as SkypeSearchUser[]
  }
  return []
}

// Pull the canonical AAD UUID out of an MRI like `8:orgid:UUID`.
// Consumer accounts (`8:live:...`, `8:cid-...`) don't have a UUID; we
// pass the raw MRI through as the user's id so downstream chat
// creation can still address them.
export function userIdFromMri(mri: string | undefined): string | null {
  if (!mri) return null
  const orgid = mri.match(/^8:orgid:([0-9a-f-]{36})$/i)
  if (orgid) return orgid[1]!.toLowerCase()
  return mri
}

export function skypeRowToDirectoryUser(row: SkypeSearchUser): DirectoryUser | null {
  const id = userIdFromMri(row.mri)
  if (!id) return null
  return {
    id,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.userPrincipalName || row.upn
      ? { userPrincipalName: row.userPrincipalName ?? row.upn }
      : {}),
    ...(row.email ? { mail: row.email } : {}),
  }
}

const externalCache = new Map<string, { ts: number; users: DirectoryUser[] }>()
const CACHE_TTL_MS = 5 * 60 * 1000

function cacheGet(key: string): DirectoryUser[] | null {
  const entry = externalCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    externalCache.delete(key)
    return null
  }
  return entry.users
}

function cacheSet(key: string, users: DirectoryUser[]): void {
  externalCache.set(key, { ts: Date.now(), users })
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return email.slice(0, 2) + '***'
  return email.slice(0, 2) + '***' + email.slice(at)
}

export async function searchExternalUsers(
  searchTerm: string,
  opts?: ExternalSearchOpts,
): Promise<DirectoryUser[]> {
  const trimmed = searchTerm.trim()
  if (!trimmed) return []
  const cacheKey = trimmed.toLowerCase()
  const cached = cacheGet(cacheKey)
  if (cached) return cached.slice(0, opts?.top ?? cached.length)

  // Teams expects a single userId-like value here (UPN, AAD object id,
  // or Skype MRI). 400 InvalidUserId is what comes back if the param
  // name or value shape is wrong; we use `userId=` because the error
  // message itself is "UserId should be Skype Mri or ADObjectId or
  // UPN" - the param name maps to that error.
  // Teams web's "find user by email" path is a POST against
  // /api/mt/part/{region}/beta/users/fetch with the email(s) in the
  // request body and `isMailAddress`/`canBeSmtpAddress` query flags
  // set so the server treats the entries as SMTP-style identifiers.
  // Confirmed via captured HAR; the previously-tried `searchUsers`
  // endpoint is for pre-resolved MRIs/UPNs only and 400s on plain
  // emails ("UserId should be Skype Mri or ADObjectId or UPN").
  const url =
    `${TEAMS_ORIGIN}/api/mt/part/${region(opts)}/beta/users/fetch` +
    `?isMailAddress=true&canBeSmtpAddress=true&enableGuest=true` +
    `&skypeTeamsInfo=true&includeIBBarredUsers=true&includeDisabledAccounts=true`
  const spacesToken = await getToken({
    profile: profile(opts),
    scope: TEAMS_SPACES_SCOPE,
  })
  const startedAt = Date.now()
  let res: Response
  try {
    res = await transport(url, {
      method: 'POST',
      headers: { ...searchHeaders(spacesToken), 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify([trimmed]),
      signal: opts?.signal,
    })
  } catch (err) {
    recordRequest({
      ts: startedAt,
      method: 'POST',
      path: '/api/mt/part/.../beta/users/fetch',
      status: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  recordRequest({
    ts: startedAt,
    method: 'POST',
    path: '/api/mt/part/.../beta/users/fetch',
    status: res.status,
    durationMs: Date.now() - startedAt,
  })
  const text = await safeFullText(res)
  if (res.status === 404) {
    cacheSet(cacheKey, [])
    return []
  }
  if (res.status < 200 || res.status >= 300) {
    throw new TeamsExternalSearchError(
      res.status,
      `teams external users/fetch ${res.status}: ${text.slice(0, 240) || 'request failed'}`,
    )
  }
  let parsed: SkypeSearchResponse | null = null
  if (text) {
    try {
      parsed = JSON.parse(text) as SkypeSearchResponse
    } catch {
      parsed = null
    }
  }
  const rows = extractRows(parsed)
  const users: DirectoryUser[] = []
  for (const row of rows) {
    const u = skypeRowToDirectoryUser(row)
    if (u) users.push(u)
  }
  recordEvent(
    'graph',
    'info',
    `external user search: term=${maskEmail(trimmed)} hits=${users.length}`,
  )
  cacheSet(cacheKey, users)
  return users.slice(0, opts?.top ?? users.length)
}

export function __setTransportForTests(t: Transport): void {
  transport = t
}

export function __resetForTests(): void {
  transport = realTransport
  externalCache.clear()
}
