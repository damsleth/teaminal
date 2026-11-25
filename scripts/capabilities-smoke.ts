// Live smoke for src/graph/capabilities.
//
// Hits real Graph and prints a per-probe result table.

import { accountRef } from '../src/account'
import { createGraphClient } from '../src/graph/client'
import { probeCapabilities } from '../src/graph/capabilities'

const profile = Bun.argv[2]
const testClient = () =>
  createGraphClient({ account: accountRef(profile), audience: 'graph', fallback: false })

const t0 = performance.now()
const caps = await probeCapabilities(testClient())
const elapsed = performance.now() - t0

const rows = (Object.entries(caps) as [string, (typeof caps)[keyof typeof caps]][]).map(
  ([area, r]) => {
    if (r.ok) return `${area.padEnd(12)}  OK`
    const status = r.status !== undefined ? ` [${r.status}]` : ''
    return `${area.padEnd(12)}  ${r.reason}${status}  ${r.message}`
  },
)

process.stdout.write([`probe_total_ms=${elapsed.toFixed(1)} (parallel)`, ...rows, ''].join('\n'))
