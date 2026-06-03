/**
 * @microsoft/tui-test configuration — Phase 2 (T2.1).
 *
 * Covers the full flow test suite under scripts/tui-loop/flows/ (native API)
 * plus the Phase 0 spike probes under scripts/spike/.
 *
 * RUNNER NOTE (discovered in T0.2):
 *   Run via Node, not Bun:  `node node_modules/@microsoft/tui-test/index.js`
 *   Reason: Bun's child_process.fork() spawns Bun workers, but workerpool uses
 *   a Node.js-specific IPC protocol — the combination deadlocks every test.
 *   Under Node the runner works correctly (even on unsupported Node 26.x).
 *   T4.3 will wire this into a package.json `tui:test` script.
 *
 * Snapshot dir: __snapshots__ (default, co-located with each test file).
 * Retries: 1 in CI (CI=1 or TEAMINAL_CI=1), 0 locally — text snaps are the gate.
 * Trace: enabled so failures can be replayed.
 */

import { defineConfig } from '@microsoft/tui-test'
import { ensureIsolatedConfig, TUI_ENV } from './scripts/tui-loop/isolatedConfig.js'

const isCI = Boolean(process.env.CI || process.env.TEAMINAL_CI)

// Isolate the seeded app's config from the developer's real ~/.config so
// snapshots are reproducible (see scripts/tui-loop/isolatedConfig.ts).
ensureIsolatedConfig()

export default defineConfig({
  // Discover both the flow tests (Phase 2+) and the spike probes (Phase 0).
  testMatch: '{scripts/tui-loop/flows,scripts/spike}/**/*.test.ts',

  // Default viewport + seeded real-app program applied to all tests unless
  // overridden with test.use(). Matches the legacy tui.config.mjs viewport:
  // 100 columns × 30 rows.
  use: {
    program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
    env: { ...TUI_ENV },
    rows: 30,
    columns: 100,
  },

  // Allow one automatic retry in CI to absorb transient PTY timing jitter.
  // Locally keep retries=0 so failures surface immediately.
  retries: isCI ? 1 : 0,

  // Record a trace for every test so failures can be inspected with
  // `node node_modules/@microsoft/tui-test/index.js --trace`.
  trace: true,

  // Per-test timeout (ms). Startup of the seeded Ink app takes ~2 s.
  timeout: 30_000,

  // Single named project: the seeded real Ink app. Individual tests may call
  // test.use() to override program / rows / columns.
  projects: [
    {
      name: 'seeded-real-app',
      testMatch: '{scripts/tui-loop/flows,scripts/spike}/**/*.test.ts',
      program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
      env: { ...TUI_ENV },
      rows: 30,
      columns: 100,
    },
  ],
})
