/**
 * Flow: theme-editor (live edit → persist → reset)
 *
 * Drives a real edit through the seeded app and asserts it round-trips to disk:
 *   open editor → `+` steps "Pane padding X" 1 → 2 → config gains the override
 *               → `r` resets the field          → the override key is removed
 *
 * This exercises the full keypress → store → re-render → persist pipeline,
 * including replaceThemeOverrides' delete-on-reset semantics (which the merge
 * path can't do). Config is isolated to its own throwaway XDG_CONFIG_HOME —
 * separate from theme-editor.test.ts so a parallel write here can never
 * perturb that snapshot, and so the developer's real config is never touched.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { test, expect } from '@microsoft/tui-test'

const ROWS = 30
const COLS = 100

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-theme-edit-'))
const CFG_FILE = path.join(CFG_DIR, 'teaminal', 'config.json')

test.use({
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { TEAMINAL_SEED: 'fixtures', XDG_CONFIG_HOME: CFG_DIR },
  rows: ROWS,
  columns: COLS,
})

const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

function readConfig(): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
  } catch {
    return null
  }
}

// Poll the config file until `predicate` holds (persist is async in the app).
async function waitForConfig(
  predicate: (cfg: Record<string, any> | null) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, any> | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cfg = readConfig()
    if (predicate(cfg)) return cfg
    if (Date.now() > deadline) return cfg
    await pause(100)
  }
}

test('theme-editor: a live edit persists and resets through the real app', async ({ terminal }) => {
  // Navigate to the open editor: Esc → Settings → Theme editor.
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  terminal.keyEscape()
  await expect(terminal.getByText('Settings')).toBeVisible()
  terminal.write('j')
  await pause()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('Theme editor')).toBeVisible()
  await pause()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('= overridden')).toBeVisible()

  // The cursor opens on the first field, "Pane padding X" (default 1). `+`
  // steps it forward; the change is written to the isolated config.
  terminal.write('+')
  const afterEdit = await waitForConfig((cfg) => cfg?.themeOverrides?.layout?.panePaddingX === 2)
  // tui-test's expect() only carries locator/terminal matchers, so assert the
  // persisted value with node:assert.
  assert.equal(afterEdit?.themeOverrides?.layout?.panePaddingX, 2)

  // `r` resets the focused field — the override key is removed, not merged.
  terminal.write('r')
  const afterReset = await waitForConfig(
    (cfg) => cfg?.themeOverrides?.layout?.panePaddingX === undefined,
  )
  assert.equal(afterReset?.themeOverrides?.layout?.panePaddingX, undefined)
})
