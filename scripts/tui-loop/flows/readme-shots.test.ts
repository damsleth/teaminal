/**
 * Flow: README screenshots
 *
 * Drives the seeded app (fixture data only) into the states shown in the
 * README and writes label-free PNGs to docs/screenshots/. There are no text
 * snapshots: the images are documentation, not a regression gate.
 *
 *   conversation     Design Sync open beside the chat list
 *   command-palette  Ctrl+P over the open conversation
 *
 * Config is isolated to a throwaway XDG_CONFIG_HOME with the dark theme.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'
import { captureTerminal } from '../render.js'

// Conversation shot: compact. Overlay shot: taller and wider so the modal fits
// and the panes stay visible around it.
const VIEW = { rows: 26, columns: 104 }
const TALL = { rows: 38, columns: 130 }

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-readme-'))
fs.mkdirSync(path.join(CFG_DIR, 'teaminal'), { recursive: true })
fs.writeFileSync(
  path.join(CFG_DIR, 'teaminal', 'config.json'),
  JSON.stringify({ theme: 'dark' }, null, 2),
)

const USE = {
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { TEAMINAL_SEED: 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: CFG_DIR },
}

const SHOTS_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms))

// The fixture's terminal, typed from the test callback so getByText and write exist.
type Term = Parameters<Parameters<typeof test>[1]>[0]['terminal']

function writeShot(terminal: Term, name: string, size: { rows: number; columns: number }): void {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  // An empty label leaves the top-left corner clear.
  const { png } = captureTerminal(terminal, size.rows, size.columns, '')
  fs.writeFileSync(path.join(SHOTS_DIR, `${name}.png`), png)
}

async function openDesignSync(terminal: Term): Promise<void> {
  terminal.write('j')
  // Keep the two keys in separate PTY chunks so the app reads them as two inputs.
  await pause()
  terminal.write('\r')
  await expect(terminal.getByText('The second one scans faster.')).toBeVisible()
  await expect(terminal.getByText('Two compact layout options landed.')).toBeVisible()
}

test.describe('readme conversation', () => {
  test.use({ ...USE, ...VIEW })

  test('readme: conversation beside the chat list', async ({ terminal }) => {
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    await openDesignSync(terminal)
    writeShot(terminal, 'conversation', VIEW)
  })
})

test.describe('readme palette', () => {
  test.use({ ...USE, ...TALL })

  test('readme: command palette', async ({ terminal }) => {
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    await openDesignSync(terminal)
    terminal.write('\x10') // Ctrl+P
    await expect(terminal.getByText('enter runs')).toBeVisible()
    terminal.write('theme')
    await expect(terminal.getByText('Settings › Theme presets')).toBeVisible()
    await expect(terminal.getByText('> theme')).toBeVisible()
    writeShot(terminal, 'command-palette', TALL)
  })
})
