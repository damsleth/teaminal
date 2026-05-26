// AsyncGW (Async Gateway) client for Teams object retrieval.
//
// Two endpoints work together:
//
//   1. `POST https://{region}.asyncgw.teams.microsoft.com/v1/{oid}/aadtokenauth`
//      exchanges a Graph/IC3 token for a session cookie. Done once per
//      session, results cached in-process per profile.
//
//   2. `GET .../v1/objects/{objectId}/views/{viewName}` returns the
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
import { TEAMS_IC3_SCOPE } from './teamsFederation'

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

// Bootstrap a session for the given profile. Issues a single
// aadtokenauth POST and caches the resulting cookie in-process. Cookie
// expiry isn't surfaced explicitly by the server; we assume a 1h TTL
// (conservative — Teams web behaves the same way), and refresh on 401.
export async function bootstrap(opts?: AsyncGwOpts): Promise<AsyncGwSession> {
  const key = profileKey(opts)
  const now = Date.now()
  const cached = sessionCache.get(key)
  if (cached && cached.expAt - now > SESSION_REFRESH_MARGIN_MS) return cached
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = (async (): Promise<AsyncGwSession> => {
    const token = await getToken({ profile: opts?.profile, scope: TEAMS_IC3_SCOPE })
    const oid = oidFromJwt(token)
    if (!oid) throw new TeamsAsyncGwError(0, 'asyncgw bootstrap: ic3 token missing oid claim')
    const host = hostForRegion(opts?.region)
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
    // The session material is returned both as a Set-Cookie header and,
    // on some regions, in the body. Prefer Set-Cookie; fall back to a
    // JSON token shape.
    const setCookie = res.headers.get('set-cookie') ?? ''
    let cookie = setCookie
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
