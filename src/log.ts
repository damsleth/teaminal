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
// modal too. When a log-file mirror is configured (see setLogFile),
// every stderr line is also appended to disk after running through the
// same redaction rules.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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
  // Mirror every structured record into the log file (when set) so
  // recordEvent calls that don't go through debug/warn/error still land
  // on disk for users who turned --log-file on. Same redaction rules.
  if (logFilePath) {
    const ts = new Date(rec.ts).toISOString()
    const level = rec.level.toUpperCase().padEnd(5)
    writeMirror(`[${ts}] ${level} ${rec.source.padEnd(8)} ${rec.message}\n`)
  }
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
  logFilePath = null
  requestRing.length = 0
  requestSubscribers.clear()
}

// Lightweight per-request log for the in-app Network diagnostics panel.
// Populated by src/graph/client.ts on every Graph attempt (including 401
// retry and 429 retries). Path-only — no full URL, no query string, no
// headers, no body — to keep IDs and tokens out of the buffer by
// construction.
export type RequestRecord = {
  ts: number
  method: HttpMethodLite
  path: string
  status: number | null
  durationMs: number
  retried429?: boolean
  retried401?: boolean
  error?: string
}

export type HttpMethodLite = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'

const REQUEST_RING_CAPACITY = 200
const requestRing: RequestRecord[] = []
const requestSubscribers = new Set<(r: RequestRecord) => void>()

let networkLogPath: string | null = null
let networkLogDirReady = false

export function setNetworkLog(path: string | null): void {
  networkLogPath = path
  networkLogDirReady = false
}

export function getNetworkLog(): string | null {
  return networkLogPath
}

function writeNetworkMirror(line: string): void {
  if (!networkLogPath) return
  try {
    if (!networkLogDirReady) {
      mkdirSync(dirname(networkLogPath), { recursive: true })
      networkLogDirReady = true
    }
    appendFileSync(networkLogPath, redactForFile(line))
  } catch {
    networkLogPath = null
  }
}

export function recordRequest(rec: RequestRecord): void {
  requestRing.push(rec)
  if (requestRing.length > REQUEST_RING_CAPACITY) {
    requestRing.splice(0, requestRing.length - REQUEST_RING_CAPACITY)
  }
  if (networkLogPath) {
    const ts = new Date(rec.ts).toISOString()
    const status = rec.status === null ? 'ERR' : String(rec.status)
    const flags = rec.retried429 ? ' r429' : rec.retried401 ? ' r401' : ''
    const errSuffix = rec.error ? ` err=${rec.error}` : ''
    writeNetworkMirror(
      `[${ts}] ${rec.method.padEnd(5)} ${status.padStart(3)} ${rec.durationMs}ms ${rec.path}${flags}${errSuffix}\n`,
    )
  }
  for (const cb of requestSubscribers) {
    try {
      cb(rec)
    } catch {
      // Drop subscriber errors.
    }
  }
}

export function getRecentRequests(): RequestRecord[] {
  return requestRing.slice()
}

export function subscribeRequests(cb: (r: RequestRecord) => void): () => void {
  requestSubscribers.add(cb)
  return () => {
    requestSubscribers.delete(cb)
  }
}

// Mirror destination for stderr lines. When set, debug/warn/error also
// append a redacted line to this file. Path is created lazily on first
// write; failure to write is silently dropped (the file mirror is a
// convenience, not a critical channel).
let logFilePath: string | null = null
let logFileDirReady = false

export function setLogFile(path: string | null): void {
  logFilePath = path
  logFileDirReady = false
}

export function getLogFile(): string | null {
  return logFilePath
}

const REDACT_TOKEN = /(Bearer\s+)[A-Za-z0-9._-]{12,}/g
const REDACT_AAD_ID =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const REDACT_EMAIL = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g

export function redactForFile(line: string): string {
  return line
    .replace(REDACT_TOKEN, '$1<redacted>')
    .replace(REDACT_AAD_ID, (m) => `<oid:${m.slice(0, 8)}>`)
    .replace(REDACT_EMAIL, (_, _local, domain) => `<email:***@${domain}>`)
}

function writeMirror(line: string): void {
  if (!logFilePath) return
  try {
    if (!logFileDirReady) {
      mkdirSync(dirname(logFilePath), { recursive: true })
      logFileDirReady = true
    }
    appendFileSync(logFilePath, redactForFile(line))
  } catch {
    // Mirror failure must not break the app. Disable further attempts
    // so we don't thrash a broken filesystem on every record.
    logFilePath = null
  }
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
  // pushRecord handles the file mirror; we only need to drive stderr
  // here. Gated on TEAMINAL_DEBUG so non-debug runs stay quiet.
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
