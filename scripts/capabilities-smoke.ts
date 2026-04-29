// Live smoke for src/graph/capabilities.
//
// Hits real Graph and prints a per-probe result table.

import { setActiveProfile } from '../src/graph/client'
import { probeCapabilities } from '../src/graph/capabilities'

const profile = Bun.argv[2]
if (profile) setActiveProfile(profile)

const t0 = performance.now()
const caps = await probeCapabilities()
const elapsed = performance.now() - t0

const rows = (Object.entries(caps) as [string, (typeof caps)[keyof typeof caps]][]).map(
  ([area, r]) => {
    if (r.ok) return `${area.padEnd(12)}  OK`
    const status = r.status !== undefined ? ` [${r.status}]` : ''
    return `${area.padEnd(12)}  ${r.reason}${status}  ${r.message}`
  },
)

process.stdout.write(
  [`probe_total_ms=${elapsed.toFixed(1)} (parallel)`, ...rows, ''].join('\n'),
)
