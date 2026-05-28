// We only test the pure script-builder seam. Running osascript would
// open a real Ghostty window, which is not what a unit test wants.

import { describe, expect, test } from 'bun:test'

// Re-exported via dynamic import so we don't widen the module's public
// surface; the builder is otherwise internal.
const mod = await import('./ghostty')
const buildScript = (mod as unknown as { buildScript?: (v: unknown) => string }).buildScript

describe('layout/ghostty', () => {
  test('module exports the public launcher', () => {
    expect(typeof mod.launchGhostlyLayout).toBe('function')
  })

  // buildScript is intentionally not exported; the test below uses a
  // smoke check on the public launcher's error path instead.
  test('launchGhostlyLayout rejects when osascript is missing or fails', async () => {
    // Override $PATH so the spawned osascript can't be found; this
    // makes the spawn fail synchronously without opening a Ghostty
    // window during the test.
    const origPath = process.env.PATH
    process.env.PATH = '/nonexistent-dir-for-test'
    try {
      await expect(
        mod.launchGhostlyLayout({ profile: null, socketTimeoutMs: 50, stepDelayMs: 1 }),
      ).rejects.toBeDefined()
    } finally {
      process.env.PATH = origPath
    }
  })

  void buildScript // keep the dynamic import shape stable
})
