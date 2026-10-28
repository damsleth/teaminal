/**
 * Flow: theme presets (save as → file + active theme → delete → fallback)
 *
 *   Esc → Settings → Theme presets → n, type a name, Enter
 *     → themes/<name>.json exists with its base, config.theme is the preset
 *   d, y → the file is gone and config.theme falls back to the preset's base
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

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-theme-presets-'))
const CFG_FILE = path.join(CFG_DIR, 'teaminal', 'config.json')
const PRESET_FILE = path.join(CFG_DIR, 'teaminal', 'themes', 'Night Owl.json')

test.use({
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { TEAMINAL_SEED: 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: CFG_DIR },
  rows: 34,
  columns: 100,
})

const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await pause(100)
  }
  return check()
}

function configTheme(): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).theme
  } catch {
    return undefined
  }
}

test('theme-presets: save as writes the preset and activates it; delete falls back', async ({
  terminal,
}) => {
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  terminal.keyEscape()
  await expect(terminal.getByText('Settings')).toBeVisible()
  terminal.write('j')
  await pause()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('Theme presets')).toBeVisible()
  await pause()
  terminal.write('j')
  await pause()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('active: dark')).toBeVisible()

  terminal.write('n')
  await expect(terminal.getByText('Save as:')).toBeVisible()
  terminal.write('Night Owl')
  await pause()
  terminal.submit()
  assert.ok(await waitFor(() => fs.existsSync(PRESET_FILE)), 'preset file written')
  const saved = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'))
  assert.equal(saved.base, 'dark')
  assert.equal(saved.settings?.showTimestampsInPane, 'on', 'preset carries the UI settings')
  assert.ok(await waitFor(() => configTheme() === 'Night Owl'), 'preset is the active theme')
  await expect(terminal.getByText('active: Night Owl')).toBeVisible()

  terminal.write('d')
  await expect(terminal.getByText('y confirm')).toBeVisible()
  terminal.write('y')
  assert.ok(await waitFor(() => !fs.existsSync(PRESET_FILE)), 'preset file deleted')
  assert.ok(await waitFor(() => configTheme() === 'dark'), 'falls back to the base theme')
})
