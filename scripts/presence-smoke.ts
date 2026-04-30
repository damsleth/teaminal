// Live smoke for src/graph/presence.
//
// Tries getMyPresence and getPresencesByUserId(self). Prints availability
// when it works or notes "unavailable" when Graph 403s. The capability
// probe earlier indicated this user's tenant returns 403 on /me/presence,
// so a non-error walk-through of the failure path is the actual smoke goal.

import { setActiveProfile, GraphError } from '../src/graph/client'
import { getMe } from '../src/graph/me'
import { getMyPresence, getPresencesByUserId } from '../src/graph/presence'

const profile = Bun.argv[2]
if (profile) setActiveProfile(profile)

async function describe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const t0 = performance.now()
    const out = await fn()
    const dt = (performance.now() - t0).toFixed(0)
    process.stdout.write(`${label}: ok (${dt}ms) ${JSON.stringify(out)}\n`)
  } catch (err) {
    if (err instanceof GraphError) {
      process.stdout.write(`${label}: ${err.status} ${err.message}\n`)
    } else {
      process.stdout.write(`${label}: error ${String(err)}\n`)
    }
  }
}

await describe('getMyPresence', () => getMyPresence())

const me = await getMe()
await describe(`getPresencesByUserId([${me.id.slice(0, 8)}...])`, () =>
  getPresencesByUserId([me.id]))

await describe('getPresencesByUserId([])', () => getPresencesByUserId([]))
