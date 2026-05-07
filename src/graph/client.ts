// Microsoft Graph HTTP client.
//
// Responsibilities:
//   - inject Authorization: Bearer from owa-piggy
//   - retry once on 401 after invalidating the token cache (covers expiry
//     between cache validation and request)
//   - retry up to 3x on 429, honoring Retry-After (seconds or HTTP-date)
//     with ±20% jitter
//   - parse JSON and non-JSON error bodies without throwing during error
//     handling
//   - paginate via @odata.nextLink (absolute URLs returned by Graph)
//   - forward AbortSignal so focus changes can cancel in-flight calls
//
// All Graph endpoints in the project go through this module. UI/state code
// must never call fetch() directly.

import { getToken, invalidate } from '../auth/owaPiggy'
import { recordRequest } from '../log'

const BASE_V1 = 'https://graph.microsoft.com/v1.0'
const BASE_BETA = 'https://graph.microsoft.com/beta'
const MAX_429_RETRIES = 3
const DEFAULT_429_BACKOFF_MS = 1000

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'

export type GraphOpts = {
  method: HttpMethod
  path: string
  query?: Record<string, string | number | undefined>
  headers?: Record<string, string | undefined>
  body?: object | string
  beta?: boolean
  scope?: string
  signal?: AbortSignal
}

export class GraphError extends Error {
  status: number
  path: string
  body: unknown

  constructor(status: number, path: string, message: string, body?: unknown) {
    super(`Graph ${status} ${path}: ${message}`)
    this.name = 'GraphError'
    this.status = status
    this.path = path
    this.body = body
  }
}

export class RateLimitError extends GraphError {
  retryAfterMs: number

  constructor(status: number, path: string, retryAfterMs: number, message: string, body?: unknown) {
    super(status, path, message, body)
    this.name = 'RateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

let activeProfile: string | undefined = undefined

export function setActiveProfile(profile: string | undefined): void {
  activeProfile = profile
}

export function getActiveProfile(): string | undefined {
  return activeProfile
}

type Transport = (url: string, init: RequestInit) => Promise<Response>
const realTransport: Transport = (url, init) => fetch(url, init)
let transport: Transport = realTransport

const realSleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
let sleep: (ms: number) => Promise<void> = realSleep

function buildUrl(opts: GraphOpts): string {
  if (opts.path.startsWith(`${BASE_V1}/`) || opts.path.startsWith(`${BASE_BETA}/`)) {
    if (!opts.query) return opts.path
    const url = new URL(opts.path)
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined) continue
      url.searchParams.append(k, String(v))
    }
    return url.toString()
  }

  const base = opts.beta ? BASE_BETA : BASE_V1
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`
  if (!opts.query) return base + path
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(opts.query)) {
    if (v === undefined) continue
    params.append(k, String(v))
  }
  const qs = params.toString()
  return qs ? `${base}${path}?${qs}` : base + path
}

export function parseRetryAfter(headerValue: string | null, now: number): number {
  if (!headerValue) return 0
  const trimmed = headerValue.trim()
  if (trimmed === '') return 0
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now)
  return 0
}

function jitter(ms: number): number {
  // ±20% jitter. Using Math.random is fine here; this is throttling, not crypto.
  return Math.round(ms * (0.8 + Math.random() * 0.4))
}

async function safeReadBody(res: Response): Promise<unknown> {
  let text: string
  try {
    text = await res.text()
  } catch {
    return undefined
  }
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function extractGraphErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown }).error
    if (err && typeof err === 'object') {
      const msg = (err as { message?: unknown }).message
      if (typeof msg === 'string' && msg.length > 0) return msg
    }
  }
  if (typeof body === 'string' && body.length > 0 && body.length < 500) return body
  return fallback
}

async function executeRequest<T>(
  url: string,
  opts: GraphOpts,
  retried401 = false,
  retried429Count = 0,
): Promise<T> {
  const token = await getToken({ profile: activeProfile, scope: opts.scope })
  const headers = new Headers({
    Accept: 'application/json',
  })
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === undefined) continue
    if (k.toLowerCase() === 'authorization') continue
    headers.set(k, v)
  }
  headers.set('Authorization', `Bearer ${token}`)

  let body: string | undefined
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') {
      body = opts.body
    } else {
      body = JSON.stringify(opts.body)
      headers.set('Content-Type', 'application/json')
    }
  }

  const init: RequestInit = {
    method: opts.method,
    headers,
    body,
  }
  if (opts.signal) init.signal = opts.signal

  const startedAt = Date.now()
  let res: Response
  try {
    res = await transport(url, init)
  } catch (err) {
    recordRequest({
      ts: startedAt,
      method: opts.method,
      path: opts.path,
      status: null,
      durationMs: Date.now() - startedAt,
      retried401: retried401 || undefined,
      retried429: retried429Count > 0 || undefined,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  recordRequest({
    ts: startedAt,
    method: opts.method,
    path: opts.path,
    status: res.status,
    durationMs: Date.now() - startedAt,
    retried401: retried401 || undefined,
    retried429: retried429Count > 0 || undefined,
  })

  if (res.status === 401 && !retried401) {
    invalidate({ profile: activeProfile, scope: opts.scope })
    return executeRequest<T>(url, opts, true, retried429Count)
  }

  if (res.status === 429) {
    if (retried429Count >= MAX_429_RETRIES) {
      const errBody = await safeReadBody(res)
      const retryMs = parseRetryAfter(res.headers.get('Retry-After'), Date.now())
      throw new RateLimitError(
        429,
        opts.path,
        retryMs,
        extractGraphErrorMessage(errBody, 'rate limited (max retries exhausted)'),
        errBody,
      )
    }
    const retryRaw = parseRetryAfter(res.headers.get('Retry-After'), Date.now())
    const waitMs = jitter(retryRaw > 0 ? retryRaw : DEFAULT_429_BACKOFF_MS)
    await sleep(waitMs)
    return executeRequest<T>(url, opts, retried401, retried429Count + 1)
  }

  if (!res.ok) {
    const errBody = await safeReadBody(res)
    const message = extractGraphErrorMessage(errBody, res.statusText || `HTTP ${res.status}`)
    throw new GraphError(res.status, opts.path, message, errBody)
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new GraphError(res.status, opts.path, 'response was not valid JSON', text)
  }
}

export async function graph<T>(opts: GraphOpts): Promise<T> {
  const url = buildUrl(opts)
  return executeRequest<T>(url, opts)
}

type PagedResponse<T> = { value: T[]; '@odata.nextLink'?: string }

// Yields successive pages of `value` from a Graph collection endpoint,
// following `@odata.nextLink` until exhausted. Callers can break out
// of `for await` to stop early.
export async function* paginate<T>(opts: GraphOpts): AsyncGenerator<T[], void, unknown> {
  let url = buildUrl(opts)
  let firstPage = true
  while (true) {
    const page = firstPage
      ? await executeRequest<PagedResponse<T>>(url, opts)
      : await executeRequest<PagedResponse<T>>(url, { ...opts, query: undefined, body: undefined })
    firstPage = false
    yield page.value ?? []
    const next = page['@odata.nextLink']
    if (!next) break
    url = next
  }
}

// Convenience: collect all pages into a single array. Use sparingly - prefer
// `paginate()` when you can stop early.
export async function paginateAll<T>(opts: GraphOpts): Promise<T[]> {
  const out: T[] = []
  for await (const page of paginate<T>(opts)) {
    out.push(...page)
  }
  return out
}

// Test-only hooks. Underscore prefix marks them as not part of the public API.
export function __setTransportForTests(t: Transport): void {
  transport = t
}

export function __setSleepForTests(s: (ms: number) => Promise<void>): void {
  sleep = s
}

export function __resetForTests(): void {
  transport = realTransport
  sleep = realSleep
  activeProfile = undefined
}
