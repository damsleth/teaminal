/**
 * Flow: account-concurrent-remove-all (M2 Phase E.4)
 *
 * concurrentAccounts on, two seeded accounts. Removing both from the
 * Accounts modal (background one first, then the foreground) leaves no
 * account at all: the shell still renders and the Accounts modal stays
 * open so an account can be added again.
 *
 * Its own config dir: the flow rewrites the config's account list.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-remove-all-'))
fs.mkdirSync(path.join(CFG_DIR, 'teaminal'), { recursive: true })
fs.writeFileSync(
  path.join(CFG_DIR, 'teaminal', 'config.json'),
  JSON.stringify({
    theme: 'dark',
    accounts: ['alpha', 'beta'],
    activeAccount: 'alpha',
    concurrentAccounts: true,
  }),
)

test.use({
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { TEAMINAL_SEED: 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: CFG_DIR },
  rows: 30,
  columns: 100,
})

const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

const screen = (terminal: { getViewableBuffer(): string[][] }) =>
  terminal
    .getViewableBuffer()
    .map((row) => row.join(''))
    .join('\n')

test('account-concurrent-remove-all: no accounts left, the shell and Accounts modal still render', async ({
  terminal,
}) => {
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  terminal.keyEscape()
  await expect(terminal.getByText('Accounts')).toBeVisible()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('Enter switch')).toBeVisible()
  // beta (background) first, then alpha (foreground, row 0 again).
  for (const down of [1, 0]) {
    for (let i = 0; i < down; i++) {
      terminal.write('j')
      await pause()
    }
    terminal.write('d')
    await pause()
    terminal.write('y')
    await pause(400)
  }
  await expect(terminal.getByText('No accounts added.')).toBeVisible()
  const out = screen(terminal)
  expect(out).not.toContain('Ada Byron')
  expect(out).not.toContain('ADA BYRON')
  // Closing the modal leaves the empty shell up.
  terminal.keyEscape()
  await pause(400)
  await expect(terminal.getByText('teaminal')).toBeVisible()
  expect(screen(terminal)).not.toContain('No accounts added.')
})
