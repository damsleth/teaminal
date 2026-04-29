// stderr-only debug log gated behind the TEAMINAL_DEBUG env var.
//
// Convention: stdout is for tool output (which Ink takes over once the UI
// renders); stderr is for diagnostics. Never log access tokens, refresh
// tokens, or full Authorization headers - even under debug.

const enabled = (() => {
  const v = process.env.TEAMINAL_DEBUG
  return v === '1' || v === 'true' || v === 'yes'
})()

export function isDebugEnabled(): boolean {
  return enabled
}

export function debug(...args: unknown[]): void {
  if (!enabled) return
  const ts = new Date().toISOString()
  const msg = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
  process.stderr.write(`[${ts}] ${msg}\n`)
}

export function warn(...args: unknown[]): void {
  const ts = new Date().toISOString()
  const msg = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
  process.stderr.write(`[${ts}] WARN ${msg}\n`)
}
