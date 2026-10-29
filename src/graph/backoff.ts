// Exponential back-off for HTTP 429 (Too Many Requests), shared by every
// outbound request: the Graph client, the Teams-service clients, the
// realtime registration and external image downloads.
//
// Wait before retry n (0-based): BASE * 2^n (1s, 2s, 4s, ...), capped at
// MAX, plus up to 20% jitter so concurrent clients spread out, and never
// shorter than the server's Retry-After. Up to MAX_429_RETRIES retries, then
// the 429 is returned to the caller. The wait ends early, with an
// AbortError, when the request's signal fires.

export const MAX_429_RETRIES = 3
export const BASE_429_BACKOFF_MS = 1000
export const MAX_429_BACKOFF_MS = 30_000

// Retry-After as milliseconds: integer / fractional seconds or an HTTP
// date; 0 when absent or unparseable.
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

export function backoff429Ms(attempt: number, retryAfterMs: number, random = Math.random): number {
  const exponential = Math.min(MAX_429_BACKOFF_MS, BASE_429_BACKOFF_MS * 2 ** attempt)
  const jittered = Math.round(exponential * (1 + 0.2 * random()))
  return Math.max(retryAfterMs, jittered)
}

type Sleep = (ms: number, signal?: AbortSignal | null) => Promise<void>

// Resolves after `ms`, or rejects with an AbortError as soon as `signal`
// fires; the timer is cleared either way, so an aborted wait doesn't keep
// the process alive.
const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

let sleep: Sleep = realSleep

export function __setBackoffSleepForTests(s: Sleep | null): void {
  sleep = s ?? realSleep
}

export async function sleepUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal || sleep === realSleep) return sleep(ms, signal)
  // Test sleeps may ignore the signal: race them against it.
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([sleep(ms, signal), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort!)
  }
}

// Send a request, retrying a 429 with exponential back-off. Returns the
// final response (a 429 too, once the retries are used up).
export async function fetchWithBackoff(
  send: () => Promise<Response>,
  signal?: AbortSignal | null,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await send()
    if (res.status !== 429 || attempt >= MAX_429_RETRIES) return res
    const wait = backoff429Ms(attempt, parseRetryAfter(res.headers.get('Retry-After'), Date.now()))
    await res.body?.cancel().catch(() => {})
    await sleepUnlessAborted(wait, signal)
  }
}

// A transport (url, init) => Response with the 429 back-off applied.
export function sendWithBackoff(
  transport: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetchWithBackoff(() => transport(url, init), init.signal)
}
