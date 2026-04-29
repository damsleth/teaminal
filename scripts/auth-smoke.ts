// Redacted manual smoke for src/auth/owaPiggy.
//
// Prints audience claim + minutes-to-expiry on two consecutive getToken calls,
// confirming the in-process cache hit on the second call. Never prints the
// token itself or any user-identifying claim.
//
// Usage:
//   bun run scripts/auth-smoke.ts            # default profile
//   bun run scripts/auth-smoke.ts work       # specific profile

import { getToken } from '../src/auth/owaPiggy'

const profile = Bun.argv[2]

function summarize(token: string): { aud: string; minutes: number } {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) throw new Error('not a JWT')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<
    string,
    unknown
  >
  const aud = typeof payload.aud === 'string' ? payload.aud : '?'
  const exp = typeof payload.exp === 'number' ? payload.exp : 0
  const minutes = Math.round((exp - Date.now() / 1000) / 60)
  return { aud, minutes }
}

const t0 = performance.now()
const a = await getToken(profile)
const t1 = performance.now()
const b = await getToken(profile)
const t2 = performance.now()

const sa = summarize(a)
const sb = summarize(b)

const profileLabel = profile ?? '<owa-default>'
process.stdout.write(
  [
    `profile=${profileLabel}`,
    `call1: aud=${sa.aud}  minutes_to_exp=${sa.minutes}  elapsed_ms=${(t1 - t0).toFixed(1)}`,
    `call2: aud=${sb.aud}  minutes_to_exp=${sb.minutes}  elapsed_ms=${(t2 - t1).toFixed(1)} (should be ~0 from in-process cache)`,
    `cache_hit=${a === b ? 'YES' : 'NO'}`,
    '',
  ].join('\n'),
)
