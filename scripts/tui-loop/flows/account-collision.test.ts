/**
 * Flow: account-collision (M2 Phase D)
 *
 * Two fixture accounts share every id (me, chats, members, messages) but not
 * their text: `beta` upper-cases names, topics and bodies. Switching accounts
 * from the Accounts modal must replace everything on screen. Any alpha text
 * left after the switch to beta (or beta text after switching back) is a
 * cross-account leak.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-accounts-'))
fs.mkdirSync(path.join(CFG_DIR, 'teaminal'), { recursive: true })
fs.writeFileSync(
  path.join(CFG_DIR, 'teaminal', 'config.json'),
  JSON.stringify({ theme: 'dark', accounts: ['alpha', 'beta'], activeAccount: 'alpha' }),
)

test.use({
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { TEAMINAL_SEED: 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: CFG_DIR },
  rows: 30,
  columns: 100,
})

// Separate keystrokes so `j` `j` doesn't arrive as one "jj" input.
const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

const screen = (terminal: { getViewableBuffer(): string[][] }) =>
  terminal
    .getViewableBuffer()
    .map((row) => row.join(''))
    .join('\n')

// Esc → menu, j → Accounts, Enter → modal, `down` rows to the account, Enter.
type Terminal = Parameters<Parameters<typeof test>[1]>[0]['terminal']
async function switchTo(terminal: Terminal, down: number) {
  terminal.keyEscape()
  await expect(terminal.getByText('Accounts')).toBeVisible()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('beta')).toBeVisible()
  for (let i = 0; i < down; i++) {
    terminal.write('j')
    await pause()
  }
  terminal.submit()
}

test('account-collision: switching accounts with identical ids shows only the new account', async ({
  terminal,
}) => {
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  terminal.submit() // open Ada's chat
  await expect(terminal.getByText('The launch notes are ready for review.')).toBeVisible()
  // Leave an unsent draft in alpha's chat; beta's chat has the same id.
  terminal.write('\t')
  await pause()
  terminal.write('alpha-only draft')
  await expect(terminal.getByText('alpha-only draft')).toBeVisible()
  terminal.keyEscape()
  await pause()

  await switchTo(terminal, 1)
  await expect(terminal.getByText('ADA BYRON')).toBeVisible()
  terminal.submit()
  await expect(terminal.getByText('THE LAUNCH NOTES ARE READY FOR REVIEW.')).toBeVisible()
  const beta = screen(terminal)
  expect(beta).not.toContain('Ada Byron')
  expect(beta).not.toContain('The launch notes are ready for review.')
  expect(beta).not.toContain('alpha-only draft')

  await switchTo(terminal, 0)
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  terminal.submit()
  await expect(terminal.getByText('The launch notes are ready for review.')).toBeVisible()
  const alpha = screen(terminal)
  expect(alpha).not.toContain('ADA BYRON')
  expect(alpha).not.toContain('THE LAUNCH NOTES')

  // Removing the running account (alpha, row 0) moves to the next one.
  // Last step on purpose: it rewrites the flow's config.
  terminal.keyEscape()
  await expect(terminal.getByText('Accounts')).toBeVisible()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('beta')).toBeVisible()
  terminal.write('d')
  await pause()
  terminal.write('y')
  await pause()
  terminal.keyEscape()
  await expect(terminal.getByText('ADA BYRON')).toBeVisible()
  expect(screen(terminal)).not.toContain('Ada Byron')
})
