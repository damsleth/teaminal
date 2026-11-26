// Requests per minute per account, from a `--network-log` file.
//
// Usage:
//   bun run scripts/network-log-summary.ts <network.log> [--skip-minutes N]
//
// --skip-minutes drops the first N minutes after the first request (the
// startup burst), so what is left is the idle cost. Every account is divided
// by the same window (first to last request kept), so the rows add up to the
// total. Lines without an account tag count under (untagged).
//
// Line format (src/log.ts recordRequest):
//   [<ISO ts>] <METHOD> <status|ERR> <N>ms <path> [@<account>] [r429|r401] [err=...]

import { readFileSync } from 'node:fs'

export type AccountSummary = {
  account: string
  requests: number
  perMinute: number
  errors: number
  throttled: number
}

export type Summary = { windowMinutes: number; total: number; accounts: AccountSummary[] }

const LINE = /^\[([^\]]+)\] (\S+)\s+(\S+) \d+ms (\S+)(?: @(\S+))?/

export function summarize(text: string, skipMinutes = 0): Summary {
  const parsed = text.split('\n').flatMap((line) => {
    const m = LINE.exec(line)
    if (!m) return []
    const ts = Date.parse(m[1]!)
    if (Number.isNaN(ts)) return []
    const status = m[3]!
    return [
      {
        ts,
        account: m[5] ?? '(untagged)',
        error: status === 'ERR' || Number(status) >= 400,
        throttled: status === '429' || line.includes(' r429'),
      },
    ]
  })
  const first = parsed.length > 0 ? Math.min(...parsed.map((r) => r.ts)) : 0
  const kept = parsed.filter((r) => r.ts >= first + skipMinutes * 60_000)
  if (kept.length === 0) return { windowMinutes: 0, total: 0, accounts: [] }
  const from = Math.min(...kept.map((r) => r.ts))
  const to = Math.max(...kept.map((r) => r.ts))
  // A window under a minute would inflate the rate; floor it at one minute.
  const windowMinutes = Math.max(1, (to - from) / 60_000)
  const byAccount = new Map<string, AccountSummary>()
  for (const r of kept) {
    const a = byAccount.get(r.account) ?? {
      account: r.account,
      requests: 0,
      perMinute: 0,
      errors: 0,
      throttled: 0,
    }
    a.requests++
    if (r.error) a.errors++
    if (r.throttled) a.throttled++
    byAccount.set(r.account, a)
  }
  const accounts = [...byAccount.values()]
    .map((a) => ({ ...a, perMinute: a.requests / windowMinutes }))
    .sort((a, b) => b.requests - a.requests)
  return { windowMinutes, total: kept.length, accounts }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  const path = args.find((a) => !a.startsWith('--'))
  const skipAt = args.indexOf('--skip-minutes')
  const skip = skipAt >= 0 ? Number(args[skipAt + 1]) : 0
  if (!path || Number.isNaN(skip)) {
    process.stderr.write(
      'usage: bun run scripts/network-log-summary.ts <network.log> [--skip-minutes N]\n',
    )
    process.exit(2)
  }
  const s = summarize(readFileSync(path, 'utf8'), skip)
  const w = Math.max(9, ...s.accounts.map((a) => a.account.length))
  process.stdout.write(`window ${s.windowMinutes.toFixed(1)} min, ${s.total} requests\n`)
  process.stdout.write(`${'account'.padEnd(w)}  requests  req/min  errors  429s\n`)
  for (const a of s.accounts) {
    process.stdout.write(
      `${a.account.padEnd(w)}  ${String(a.requests).padStart(8)}  ${a.perMinute.toFixed(1).padStart(7)}  ${String(a.errors).padStart(6)}  ${String(a.throttled).padStart(4)}\n`,
    )
  }
  const total = s.total / (s.windowMinutes || 1)
  process.stdout.write(
    `${'total'.padEnd(w)}  ${String(s.total).padStart(8)}  ${total.toFixed(1).padStart(7)}\n`,
  )
}
