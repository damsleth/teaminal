/**
 * Flow: account-toggle
 *
 * Concurrent mode (the default), two seeded accounts: `beta` upper-cases
 * names. Space in the Accounts modal turns beta off: its section leaves the
 * unified sidebar, the row stays listed as `off`, and alpha keeps running.
 * Space again turns it on and its section comes back without a restart.
 * With every account off at startup no account opens and the Accounts modal
 * is up; Space starts one in front.
 *
 * Its own config dirs: the flow rewrites disabledAccounts.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

function useConfig(disabledAccounts: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-toggle-'))
  fs.mkdirSync(path.join(dir, 'teaminal'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'teaminal', 'config.json'),
    JSON.stringify({
      theme: 'dark',
      accounts: ['alpha', 'beta'],
      activeAccount: 'alpha',
      disabledAccounts,
    }),
  )
  test.use({
    program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
    env: { TEAMINAL_SEED: 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: dir },
    rows: 30,
    columns: 100,
  })
  return dir
}

const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

const screen = (terminal: { getViewableBuffer(): string[][] }) =>
  terminal
    .getViewableBuffer()
    .map((row) => row.join(''))
    .join('\n')

type Terminal = Parameters<Parameters<typeof test>[1]>[0]['terminal']
// Esc → menu, j → Accounts, Enter → modal, j → beta's row, Space.
async function toggleBeta(terminal: Terminal) {
  terminal.keyEscape()
  await expect(terminal.getByText('Accounts')).toBeVisible()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('Space on/off')).toBeVisible()
  terminal.write('j')
  await pause()
  terminal.write(' ')
  await pause(400)
}

test.describe('one of two off and on', () => {
  const dir = useConfig([])
  test('account-toggle: Space turns an account off and on without removing it', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ADA BYRON')).toBeVisible()
    await expect(terminal.getByText('▾ beta')).toBeVisible()

    await toggleBeta(terminal)
    await expect(terminal.getByText('beta  off')).toBeVisible()
    await expect(terminal.getByText('alpha  foreground')).toBeVisible()
    terminal.keyEscape()
    await pause(400)
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    // One account open: no unified sidebar, so no beta section or header.
    const off = screen(terminal)
    expect(off).not.toContain('ADA BYRON')
    expect(off).not.toContain('▾ beta')
    const config = JSON.parse(
      fs.readFileSync(path.join(dir, 'teaminal', 'config.json'), 'utf8'),
    ) as { accounts: string[]; disabledAccounts: string[] }
    expect(config.accounts).toEqual(['alpha', 'beta'])
    expect(config.disabledAccounts).toEqual(['beta'])

    await toggleBeta(terminal)
    await expect(terminal.getByText('beta  running')).toBeVisible()
    terminal.keyEscape()
    await pause(400)
    await expect(terminal.getByText('ADA BYRON')).toBeVisible()
    await expect(terminal.getByText('▾ beta')).toBeVisible()
  })
})

test.describe('every account off at startup', () => {
  useConfig(['alpha', 'beta'])
  test('account-toggle: no account opens, the Accounts modal is up; Space starts one', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('alpha  off')).toBeVisible()
    await expect(terminal.getByText('beta  off')).toBeVisible()
    // Opening an account in front closes the modal, as adding one does.
    terminal.write(' ')
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    const out = screen(terminal)
    expect(out).not.toContain('Space on/off')
    expect(out).not.toContain('ADA BYRON')
  })
})
