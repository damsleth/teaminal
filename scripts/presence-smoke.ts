// Live smoke for src/graph/presence.
//
// Tries getMyPresence and getPresencesByUserId(self). Prints availability
// when it works or notes "unavailable" when Graph 403s. The capability
// probe earlier indicated this user's tenant returns 403 on /me/presence,
// so a non-error walk-through of the failure path is the actual smoke goal.

import { accountRef } from '../src/account'
import { createGraphClient, GraphError } from '../src/graph/client'
import { getMe } from '../src/graph/me'
import { getMyPresence, getPresencesByUserId } from '../src/graph/presence'

const profile = Bun.argv[2]
const testClient = () =>
  createGraphClient({ account: accountRef(profile), audience: 'graph', fallback: false })

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

await describe('getMyPresence', () => getMyPresence(testClient()))

const me = await getMe(testClient())
await describe(`getPresencesByUserId([${me.id.slice(0, 8)}...])`, () =>
  getPresencesByUserId(testClient(), [me.id]))

await describe('getPresencesByUserId([])', () => getPresencesByUserId(testClient(), []))
