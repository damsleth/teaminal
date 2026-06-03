// Deterministic config isolation for the tui-test harness.
//
// The seeded app resolves its config via `getConfigPath`, which checks
// `XDG_CONFIG_HOME` first and otherwise falls back to `os.homedir()` — and
// tui-test passes only the *configured* env to the spawned program, never the
// runner's process env. Without this, snapshots bake in whatever sits in the
// developer's real ~/.config/teaminal/config.json (personal themeOverrides,
// custom colors, etc.) and are not reproducible on CI or another machine.
//
// Pointing XDG_CONFIG_HOME at a clean temp dir with a pinned `theme: 'dark'`
// (the default `theme: 'auto'` would resolve via OS appearance and diverge
// across machines) makes the snapshots deterministic. Every env declaration in
// the harness — config `use`, the project, and each flow's `test.use()` — must
// set XDG_CONFIG_HOME to this path, because tui-test REPLACES env per level
// rather than merging.

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const TUI_CONFIG_HOME = path.join(os.tmpdir(), 'teaminal-tui-test-xdg')

// Reset the isolated config to a deterministic baseline: dark theme, no
// overrides → built-in defaults. Idempotent; safe to call from every module
// that imports this (config load + each flow). Overwrites any state a previous
// run's theme-editor flow may have persisted.
export function ensureIsolatedConfig(): string {
  const dir = path.join(TUI_CONFIG_HOME, 'teaminal')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ theme: 'dark' }, null, 2))
  return TUI_CONFIG_HOME
}

export const TUI_ENV = { TEAMINAL_SEED: 'fixtures', XDG_CONFIG_HOME: TUI_CONFIG_HOME } as const
