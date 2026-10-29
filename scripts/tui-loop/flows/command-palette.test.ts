/**
 * Flow: command palette (Ctrl+P → filter → Enter runs the command)
 *
 *   Ctrl+P opens the palette → typing "center dates" ranks the Settings item
 *   first → Enter toggles it → config.json gains centerDateMarkers: true and
 *   the palette is closed. Ctrl+P, "design sync", Enter opens that chat.
 *
 * Config is isolated to a throwaway XDG_CONFIG_HOME.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { test, expect } from '@microsoft/tui-test'

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-palette-'))
const CFG_FILE = path.join(CFG_DIR, 'teaminal', 'config.json')

test.use({
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { TEAMINAL_SEED: 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: CFG_DIR },
  rows: 30,
  columns: 100,
})

const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

async function waitForConfig(
  predicate: (cfg: Record<string, any> | null) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, any> | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let cfg: Record<string, any> | null = null
    try {
      cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
    } catch {}
    if (predicate(cfg)) return cfg
    if (Date.now() > deadline) return cfg
    await pause(100)
  }
}

test('command-palette: filter, run a setting, jump to a chat', async ({ terminal }) => {
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  terminal.write('\x10') // Ctrl+P
  await expect(terminal.getByText('enter runs')).toBeVisible()
  terminal.write('center dates')
  await expect(terminal.getByText('Settings › Center dates')).toBeVisible()
  await pause()
  terminal.submit()
  const cfg = await waitForConfig((c) => c?.centerDateMarkers === true)
  assert.equal(cfg?.centerDateMarkers, true)
  await expect(terminal.getByText('enter runs')).not.toBeVisible()

  terminal.write('\x10')
  await expect(terminal.getByText('enter runs')).toBeVisible()
  terminal.write('go to design')
  await expect(terminal.getByText('Go to Design Sync')).toBeVisible()
  await pause()
  terminal.submit()
  await expect(terminal.getByText('enter runs')).not.toBeVisible()
  // The Design Sync conversation is open: its seeded message shows.
  await expect(terminal.getByText('The second one scans faster.')).toBeVisible()
})
