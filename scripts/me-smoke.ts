// Live smoke for src/graph/client + src/graph/me.
//
// Hits real /me through the graph client, prints displayName + redacted id
// + a second-call latency to confirm cached-token reuse.
//
// Usage:
//   bun run scripts/me-smoke.ts            # default profile
//   bun run scripts/me-smoke.ts work       # specific profile

import { setActiveProfile } from '../src/graph/client'
import { getMe } from '../src/graph/me'

const profile = Bun.argv[2]
if (profile) setActiveProfile(profile)

const profileLabel = profile ?? '<owa-default>'

const t0 = performance.now()
const me1 = await getMe()
const t1 = performance.now()
const me2 = await getMe()
const t2 = performance.now()

const idPrefix = `${me1.id.slice(0, 8)}...`
process.stdout.write(
  [
    `profile=${profileLabel}`,
    `displayName=${me1.displayName}`,
    `id=${idPrefix}`,
    `mail_present=${me1.mail !== null}`,
    `call1_ms=${(t1 - t0).toFixed(1)}`,
    `call2_ms=${(t2 - t1).toFixed(1)} (no token re-spawn expected; only HTTP)`,
    `same_id=${me1.id === me2.id ? 'YES' : 'NO'}`,
    '',
  ].join('\n'),
)
