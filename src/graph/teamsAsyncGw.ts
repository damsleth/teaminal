// AsyncGW (Async Gateway) client for Teams object retrieval.
//
// Two endpoints work together:
//
//   1. An auth exchange that mints a session cookie, done once per session and
//      cached in-process per profile. We prefer `POST .../v1/skypetokenauth`
//      (Skype token) because the default owa-piggy FOCI client can mint that,
//      and fall back to `POST .../v1/{oid}/aadtokenauth` (ic3 Bearer) for
//      clients carrying Teams.AccessAsUser.All (the 5e3ce6c0 Teams web client).
//
//   2. `GET .../v1/{oid}/objects/{objectId}/views/{viewName}` returns the
//      object bytes — image, voice message, file. {viewName} is one of
//      'original', 'imgo', 'imgpsh_fullsize', etc.; each is a resize/
//      encoding variant. We always request 'imgpsh_fullsize' for images
//      and 'original' for files / voice.
//
// SECURITY: AsyncGW URLs are short-lived signed objects. Never log the
// signed URL; never write it to disk. The session cookie is treated
// with the same care as the Skype token.

import { getToken } from '../auth/owaPiggy'
import { recordEvent, recordRequest } from '../log'
import { getActiveProfile } from './client'
import { getSkypeToken, TEAMS_IC3_SCOPE } from './teamsFederation'

const ASYNCGW_HOST_BY_REGION: Record<string, string> = {
  emea: 'https://eu-prod.asyncgw.teams.microsoft.com',
  amer: 'https://na-prod.asyncgw.teams.microsoft.com',
  apac: 'https://ap-prod.asyncgw.teams.microsoft.com',
  ind: 'https://in-prod.asyncgw.teams.microsoft.com',
}
const ASYNCGW_DEFAULT_HOST = 'https://eu-prod.asyncgw.teams.microsoft.com'

// Defensive cap — voice messages and files can be sizable, but anything
// over this points at something we shouldn't be inlining in a TUI.
export const MAX_OBJECT_BYTES = 16 * 1024 * 1024

export class TeamsAsyncGwError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TeamsAsyncGwError'
  }
}

export type AsyncGwSession = {
  /** Profile this session was minted for. */
  profile: string | undefined
  /** Regional AsyncGW host the session is valid against. */
  host: string
  /** Bearer/cookie material the server returns from aadtokenauth. */
  cookie: string
  /** Epoch ms after which the session is considered stale. */
  expAt: number
  /** AAD object id of the authenticated user (for URL templating). */
  userOid: string
}

export type AsyncGwOpts = {
  profile?: string
  signal?: AbortSignal
  region?: string
}

type Transport = (url: string, init: RequestInit) => Promise<Response>
const realTransport: Transport = (url, init) => fetch(url, init)
let transport: Transport = realTransport

const sessionCache = new Map<string, AsyncGwSession>()
const inFlight = new Map<string, Promise<AsyncGwSession>>()

const SESSION_REFRESH_MARGIN_MS = 60_000

function profileKey(opts?: AsyncGwOpts): string {
  return opts?.profile ?? getActiveProfile() ?? '<default>'
}

function hostForRegion(region: string | undefined): string {
  if (!region) return ASYNCGW_DEFAULT_HOST
  return ASYNCGW_HOST_BY_REGION[region.toLowerCase()] ?? ASYNCGW_DEFAULT_HOST
}

// Pull the AAD oid claim out of an IC3 token JWT (best effort — for the
// aadtokenauth URL template).
function oidFromJwt(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
    const oid = payload?.oid
    return typeof oid === 'string' && oid.length > 0 ? oid : null
  } catch {
    return null
  }
}

// Hosts are matched against the asyncgw regional prefixes only — never
// log the full signed URL.
function isAsyncGwUrl(url: string): boolean {
  return /^https:\/\/[a-z-]+\.asyncgw\.teams\.microsoft\.com\//i.test(url)
}

export function asyncGwHostForUrl(url: string): string | null {
  const m = url.match(/^(https:\/\/[a-z-]+\.asyncgw\.teams\.microsoft\.com)\//i)
  return m ? m[1]! : null
}

// Pull the first `name=value` pair out of a Set-Cookie header, dropping the
// attributes (Path, Expires, …) so it can be re-sent as a Cookie header.
function cookiePairFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0]?.trim() ?? ''
}

// Auth path 1 (preferred): exchange the Skype token for a session cookie via
// `POST {host}/v1/skypetokenauth`. This works with the default owa-piggy FOCI
// client, which can mint the Skype token (via authsvc) but NOT an ic3 Bearer
// carrying Teams.AccessAsUser.All — the scope aadtokenauth/the object Bearer
// require, available only to the 5e3ce6c0 Teams web client. Returns the cookie
// pair, or null so the caller can fall back to aadtokenauth.
async function authViaSkypeToken(host: string, opts?: AsyncGwOpts): Promise<string | null> {
  let skypeToken: string
  try {
    skypeToken = await getSkypeToken({
      profile: opts?.profile,
      region: opts?.region,
      signal: opts?.signal,
    })
  } catch (err) {
    recordEvent(
      'graph',
      'debug',
      `asyncgw skypetokenauth skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
  const url = `${host}/v1/skypetokenauth`
  const startedAt = Date.now()
  let res: Response
  try {
    res = await transport(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: `skypetoken=${encodeURIComponent(skypeToken)}`,
      signal: opts?.signal,
    })
  } catch (err) {
    recordRequest({
      ts: startedAt,
      method: 'POST',
      path: '/v1/skypetokenauth',
      status: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  recordRequest({
    ts: startedAt,
    method: 'POST',
    path: '/v1/skypetokenauth',
    status: res.status,
    durationMs: Date.now() - startedAt,
  })
  if (!res.ok) {
    recordEvent(
      'graph',
      'warn',
      `asyncgw skypetokenauth ${res.status}; falling back to aadtokenauth`,
    )
    return null
  }
  return cookiePairFromSetCookie(res.headers.get('set-cookie') ?? '') || null
}

// Auth path 2 (fallback): the Teams web-client flow — exchange an ic3 Bearer
// for a session cookie via `POST {host}/v1/{oid}/aadtokenauth`. Requires the
// Bearer to carry Teams.AccessAsUser.All (5e3ce6c0); 403s otherwise. Throws on
// failure since it's the last resort.
async function authViaAadToken(host: string, oid: string, opts?: AsyncGwOpts): Promise<string> {
  const token = await getToken({ profile: opts?.profile, scope: TEAMS_IC3_SCOPE })
  const url = `${host}/v1/${encodeURIComponent(oid)}/aadtokenauth`
  const startedAt = Date.now()
  let res: Response
  try {
    res = await transport(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: opts?.signal,
    })
  } catch (err) {
    recordRequest({
      ts: startedAt,
      method: 'POST',
      path: '/v1/.../aadtokenauth',
      status: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  recordRequest({
    ts: startedAt,
    method: 'POST',
    path: '/v1/.../aadtokenauth',
    status: res.status,
    durationMs: Date.now() - startedAt,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TeamsAsyncGwError(
      res.status,
      `asyncgw aadtokenauth ${res.status}: ${text.slice(0, 240) || 'request failed'}`,
    )
  }
  const setCookie = res.headers.get('set-cookie') ?? ''
  let cookie = cookiePairFromSetCookie(setCookie)
  if (!cookie) {
    try {
      const body = (await res.json()) as { token?: string; sessionToken?: string }
      cookie = body.token ?? body.sessionToken ?? ''
    } catch {
      cookie = ''
    }
  }
  if (!cookie) {
    throw new TeamsAsyncGwError(res.status, 'asyncgw aadtokenauth: no session material in response')
  }
  return cookie
}

// Bootstrap a session for the given profile and cache the resulting cookie
// in-process. Tries the Skype-token auth first (works with the default FOCI
// client), falling back to aadtokenauth for clients that carry an ic3 Bearer
// with Teams.AccessAsUser.All. Cookie expiry isn't surfaced explicitly; we
// assume a 1h TTL (conservative — Teams web behaves the same way) and refresh
// on 401.
export async function bootstrap(opts?: AsyncGwOpts): Promise<AsyncGwSession> {
  const key = profileKey(opts)
  const now = Date.now()
  const cached = sessionCache.get(key)
  if (cached && cached.expAt - now > SESSION_REFRESH_MARGIN_MS) return cached
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = (async (): Promise<AsyncGwSession> => {
    // The object URL is templated with the user's AAD oid; read it from any
    // FOCI token's claims (works regardless of which auth path succeeds).
    const idToken = await getToken({ profile: opts?.profile, scope: TEAMS_IC3_SCOPE })
    const oid = oidFromJwt(idToken)
    if (!oid) throw new TeamsAsyncGwError(0, 'asyncgw bootstrap: token missing oid claim')
    const host = hostForRegion(opts?.region)
    const cookie = (await authViaSkypeToken(host, opts)) ?? (await authViaAadToken(host, oid, opts))
    const session: AsyncGwSession = {
      profile: opts?.profile,
      host,
      cookie,
      // 1h TTL — refresh-on-401 below covers premature expiry.
      expAt: Date.now() + 60 * 60_000,
      userOid: oid,
    }
    sessionCache.set(key, session)
    recordEvent('graph', 'info', `asyncgw session ready for profile=${key}`)
    return session
  })()
  inFlight.set(key, promise)
  try {
    return await promise
  } finally {
    inFlight.delete(key)
  }
}

function authHeadersForSession(session: AsyncGwSession): Record<string, string> {
  // The cookie format depends on whether the server returned Set-Cookie
  // (use as `Cookie:`) or a bearer-style token (use as `Authorization`).
  // Heuristic: presence of an '=' before any ';' suggests a Cookie value.
  if (session.cookie.includes('=')) {
    return { Cookie: session.cookie }
  }
  return { Authorization: `Bearer ${session.cookie}` }
}

// Fetch an asyncgw object by its full URL. Used for URLs that arrive
// pre-formed in message bodies (e.g. inline-image src). On 401, the
// session cache is invalidated and the call is retried once.
export async function fetchObjectByUrl(
  url: string,
  opts?: AsyncGwOpts,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!isAsyncGwUrl(url)) {
    throw new TeamsAsyncGwError(0, `asyncgw fetch: not an asyncgw URL`)
  }
  const region = opts?.region ?? regionFromAsyncGwHost(asyncGwHostForUrl(url) ?? '')
  const performOnce = async (): Promise<{ bytes: Uint8Array; contentType: string }> => {
    const session = await bootstrap({ ...opts, region })
    const startedAt = Date.now()
    let res: Response
    try {
      res = await transport(url, {
        method: 'GET',
        headers: authHeadersForSession(session),
        signal: opts?.signal,
      })
    } catch (err) {
      recordRequest({
        ts: startedAt,
        method: 'GET',
        path: '/v1/objects/.../views/...',
        status: null,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
    recordRequest({
      ts: startedAt,
      method: 'GET',
      path: '/v1/objects/.../views/...',
      status: res.status,
      durationMs: Date.now() - startedAt,
    })
    if (!res.ok) {
      const status = res.status
      if (status === 401) {
        sessionCache.delete(profileKey(opts))
      }
      const text = await res.text().catch(() => '')
      throw new TeamsAsyncGwError(
        status,
        `asyncgw fetch ${status}: ${text.slice(0, 240) || 'request failed'}`,
      )
    }
    const ab = await res.arrayBuffer()
    const bytes = new Uint8Array(ab)
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      throw new TeamsAsyncGwError(0, `asyncgw fetch: object exceeds ${MAX_OBJECT_BYTES} bytes`)
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    return { bytes, contentType }
  }
  try {
    return await performOnce()
  } catch (err) {
    if (err instanceof TeamsAsyncGwError && err.status === 401) {
      recordEvent('graph', 'warn', 'asyncgw 401; refreshing session and retrying once')
      return await performOnce()
    }
    throw err
  }
}

// Fetch an asyncgw object by its raw object id (e.g. "0-wch-d2-...") plus a
// view name ('imgpsh_fullsize' full / 'imgo' thumbnail). Builds the URL from
// the session's host + authenticated user oid:
//   {host}/v1/{userOid}/objects/{objectId}/views/{view}
// Used for Conditional-Access-gated (ic3) accounts where the Graph
// hostedContents endpoint 401s but the object is reachable via asyncgw.
export async function fetchObjectById(
  objectId: string,
  opts?: AsyncGwOpts & { view?: string },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const session = await bootstrap(opts)
  const view = opts?.view ?? 'imgpsh_fullsize'
  const url = `${session.host}/v1/${encodeURIComponent(session.userOid)}/objects/${encodeURIComponent(
    objectId,
  )}/views/${encodeURIComponent(view)}`
  return fetchObjectByUrl(url, opts)
}

function regionFromAsyncGwHost(host: string): string | undefined {
  const m = host.match(/^https:\/\/([a-z]+)-prod\.asyncgw\./i)
  if (!m) return undefined
  const prefix = m[1]!.toLowerCase()
  // 'eu' → 'emea', 'na' → 'amer', 'ap' → 'apac', 'in' → 'ind'.
  const map: Record<string, string> = {
    eu: 'emea',
    na: 'amer',
    ap: 'apac',
    in: 'ind',
  }
  return map[prefix]
}

export { isAsyncGwUrl }

export function __setTransportForTests(t: Transport): void {
  transport = t
}

export function __resetForTests(): void {
  transport = realTransport
  sessionCache.clear()
  inFlight.clear()
}
