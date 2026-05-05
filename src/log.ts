// stderr-only debug log + an in-memory ring buffer of structured event
// records.
//
// stdout is for tool output (which Ink takes over once the UI renders);
// stderr is for diagnostics. Never log access tokens, refresh tokens, or
// full Authorization headers - even under debug.
//
// Structured records (recordEvent) are kept in a 500-entry ring buffer
// in process memory and surfaced via the in-app Events modal. The
// existing `debug` channel still writes to stderr but also tees a
// matching record into the buffer so any debug() call shows up in the
// modal too. `--log-file` (planned) mirrors stderr to a file with the
// same redaction rules.

const enabled = (() => {
  const v = process.env.TEAMINAL_DEBUG
  return v === '1' || v === 'true' || v === 'yes'
})()

export function isDebugEnabled(): boolean {
  return enabled
}

export type EventSource =
  | 'poller'
  | 'graph'
  | 'auth'
  | 'trouter'
  | 'realtime'
  | 'notify'
  | 'ui'
  | 'config'
  | 'app'
  | 'unknown'

export type EventLevel = 'debug' | 'info' | 'warn' | 'error'

export type EventRecord = {
  ts: number
  source: EventSource
  level: EventLevel
  message: string
  meta?: Record<string, string | number | boolean>
}

const RING_CAPACITY = 500
const ring: EventRecord[] = []
const subscribers = new Set<(r: EventRecord) => void>()

function pushRecord(rec: EventRecord): void {
  ring.push(rec)
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY)
  for (const cb of subscribers) {
    try {
      cb(rec)
    } catch {
      // Subscribers must not throw into the logger. Drop and move on.
    }
  }
}

export function recordEvent(
  source: EventSource,
  level: EventLevel,
  message: string,
  meta?: EventRecord['meta'],
): void {
  pushRecord({ ts: Date.now(), source, level, message, meta })
}

/**
 * Snapshot of the most recent records, oldest first. Returns a fresh
 * array so callers can sort/filter without mutating the ring.
 */
export function getRecentEvents(): EventRecord[] {
  return ring.slice()
}

export function subscribeEvents(cb: (r: EventRecord) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function __resetEventsForTests(): void {
  ring.length = 0
  subscribers.clear()
}

function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
}

// Best-effort source classification from the leading args. Strings
// of the shape "poller[active]:" or "graph:" prefix the source so the
// modal can color/filter without each call site having to switch APIs.
function detectSource(msg: string): EventSource {
  const head = msg.match(/^(\w+)/)?.[1]?.toLowerCase()
  if (!head) return 'unknown'
  if (
    head === 'poller' ||
    head === 'graph' ||
    head === 'auth' ||
    head === 'trouter' ||
    head === 'realtime' ||
    head === 'notify' ||
    head === 'ui' ||
    head === 'config' ||
    head === 'app'
  ) {
    return head
  }
  return 'unknown'
}

export function debug(...args: unknown[]): void {
  const msg = formatArgs(args)
  // Always tee into the ring so the events modal still shows debug
  // entries even when TEAMINAL_DEBUG is off. stderr is gated.
  pushRecord({ ts: Date.now(), source: detectSource(msg), level: 'debug', message: msg })
  if (!enabled) return
  const ts = new Date().toISOString()
  process.stderr.write(`[${ts}] ${msg}\n`)
}

export function warn(...args: unknown[]): void {
  const msg = formatArgs(args)
  pushRecord({ ts: Date.now(), source: detectSource(msg), level: 'warn', message: msg })
  const ts = new Date().toISOString()
  process.stderr.write(`[${ts}] WARN ${msg}\n`)
}

export function error(...args: unknown[]): void {
  const msg = formatArgs(args)
  pushRecord({ ts: Date.now(), source: detectSource(msg), level: 'error', message: msg })
  const ts = new Date().toISOString()
  process.stderr.write(`[${ts}] ERROR ${msg}\n`)
}
