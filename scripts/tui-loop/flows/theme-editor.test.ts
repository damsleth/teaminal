/**
 * Flow: theme-editor (open + render)
 *
 * Verifies the live theme/layout editor opens from the menu and renders its
 * field list + preview:
 *   Esc                 → open the pause menu
 *   j j  Enter          → Settings submenu
 *   j    Enter          → Theme editor (the row directly under "Theme")
 *
 * Config is isolated to a throwaway, empty XDG_CONFIG_HOME so the snapshot is
 * deterministic (defaults, no user overrides) AND so the editor can never
 * touch the developer's real ~/.config/teaminal/config.json. This test only
 * opens + navigates — it makes no persisting edits, so the dir stays empty.
 *
 * The live-edit / persist / reset round-trip is covered separately in
 * theme-editor-edit.test.ts (its own isolated config dir, so a parallel write
 * there can never perturb this snapshot).
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'
import { captureTerminal } from '../render.js'

const ROWS = 30
const COLS = 100

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-theme-'))

test.use({
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { TEAMINAL_SEED: 'fixtures', XDG_CONFIG_HOME: CFG_DIR },
  rows: ROWS,
  columns: COLS,
})

const SHOTS_DIR = path.resolve(process.cwd(), '.tui-loop/shots/theme-editor')

// Space consecutive keystrokes apart: two `j` writes in the same PTY chunk
// arrive as the single input "jj", which the menu's strict `ch === 'j'` check
// ignores. A short gap keeps each keypress its own input event.
const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

async function writeShot(
  terminal: Parameters<typeof captureTerminal>[0],
  name: string,
  label: string,
): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  try {
    const { svg, png } = captureTerminal(terminal, ROWS, COLS, label)
    fs.writeFileSync(path.join(SHOTS_DIR, `${name}.svg`), svg, 'utf8')
    fs.writeFileSync(path.join(SHOTS_DIR, `${name}.png`), png)
  } catch {
    // Visual render is best-effort — text snapshot is the gate.
  }
}

test('theme-editor: opens from Settings and renders fields + preview', async ({ terminal }) => {
  // Wait for the seeded Ink app to paint.
  await expect(terminal.getByText('Ada Byron')).toBeVisible()

  // Esc opens the pause menu (listKeys → openMenu).
  terminal.keyEscape()
  await expect(terminal.getByText('Settings')).toBeVisible()

  // Down to "Settings" (Resume → Accounts → Settings), open it.
  terminal.write('j')
  await pause()
  terminal.write('j')
  await pause()
  terminal.submit()
  // "Theme editor" is the menu row directly under "Theme" in the submenu.
  await expect(terminal.getByText('Theme editor')).toBeVisible()

  // Down one (Theme → Theme editor), open the editor.
  await pause()
  terminal.write('j')
  await pause()
  terminal.submit()

  // The editor's distinctive chrome: the override legend + a section header.
  // Neither appears anywhere else, so they prove the modal opened (not just
  // the same-named menu row).
  await expect(terminal.getByText('= overridden')).toBeVisible()
  await expect(terminal.getByText('Spacing / Layout')).toBeVisible()

  // Text-snapshot gate for the open editor.
  await expect(terminal).toMatchSnapshot({ includeColors: true })

  // Agent-facing artifacts.
  await writeShot(terminal, 'theme-editor-open', 'Theme editor open')

  // Esc closes back to the chat list.
  terminal.keyEscape()
  await expect(terminal.getByText('= overridden')).not.toBeVisible()
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
})
