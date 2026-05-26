// Polling intervals and backoff math.
//
// Adaptive polling: each loop has its own consecutive-error counter and
// applies an exponential backoff capped at 60s. The next interval gets
// ±20% jitter so multiple teaminal instances do not align perfectly.

// Base interval used when realtime push is NOT connected and the
// terminal is focused. Trouter-degraded operation drops the active
// loop to ~10s so message latency stays in the same range as the
// previous fixed 5s default without the steady-state cost when push
// is healthy.
export const ACTIVE_DEFAULT_MS = 10_000
export const LIST_DEFAULT_MS = 30_000
export const PRESENCE_DEFAULT_MS = 60_000

// When realtime push (trouter) is connected, every loop's role flips
// from "main source of freshness" to "belt-and-suspenders sanity
// check". 60s on all three is plenty.
export const REALTIME_CONNECTED_MS = 60_000

// When the terminal is blurred (background tab / minimized window),
// no user is watching. Stretch every loop to a 5-min heartbeat so we
// don't pay for invisible work.
export const BLURRED_MS = 5 * 60_000

export const BACKOFF_BASE = 1.5
export const BACKOFF_CAP_MS = 60_000

export type IntervalSource = {
  realtimeState?: string | undefined
  terminalFocused?: boolean | undefined
}

// Per-loop adaptive interval. Each loop falls back to its own base
// when neither stretch nor compression applies. `baseMs` is the
// "trouter-degraded but focused" rate the loop should run at.
export function adaptiveIntervalMs(baseMs: number, source: IntervalSource): number {
  if (source.terminalFocused === false) return BLURRED_MS
  if (source.realtimeState === 'connected') return REALTIME_CONNECTED_MS
  return baseMs
}

// Cap the per-tick member-presence fan-out. Graph and the Teams unified-
// presence endpoint both accept much larger batches, but we only render
// presence dots for visible 1:1 chats and the user's hot list rarely
// exceeds a few dozen names. Keep the budget tight so a 500-chat tenant
// does not pay for invisible work every minute.
export const MEMBER_PRESENCE_LIMIT = 50

/** ±20% jitter applied to every sleep interval. */
export function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4))
}

/**
 * Exponential backoff capped at BACKOFF_CAP_MS. `consecutive` is the
 * error counter for the loop; 0 returns the base interval unchanged.
 */
export function backoff(baseMs: number, consecutive: number): number {
  if (consecutive === 0) return baseMs
  const raised = baseMs * Math.pow(BACKOFF_BASE, consecutive)
  return Math.min(BACKOFF_CAP_MS, raised)
}

/**
 * Recognises the various shapes Bun's fetch / DOM AbortController throw
 * when an in-flight request is cancelled. Used to suppress legitimate
 * abort signals from the error counter / onError callback.
 */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return true
  // Bun's fetch may throw a DOMException-shaped error with code === 20 or
  // an Error with message containing "aborted". Be permissive.
  return /aborted|abort/i.test(err.message)
}
