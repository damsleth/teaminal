/**
 * Flow: account-unified (M2 F.3 / F.4)
 *
 * concurrentAccounts on with two or three seeded accounts that share every
 * id: `beta` upper-cases names, topics and bodies, `gamma` appends
 * " (gamma)". Every account gets its own section in one sidebar, under an
 * account header. Opening a row brings its account to the foreground; the
 * message pane then shows that account's text only, and the status bar names
 * it.
 *
 * Each test gets its own config dir: collapsing an account persists.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

function useAccounts(accounts: string[], size = { rows: 30, columns: 100 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-unified-'))
  fs.mkdirSync(path.join(dir, 'teaminal'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'teaminal', 'config.json'),
    JSON.stringify({
      theme: 'dark',
      accounts,
      activeAccount: accounts[0],
      concurrentAccounts: true,
    }),
  )
  test.use({
    program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
    env: { TEAMINAL_SEED: 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: dir },
    ...size,
  })
}

// Separate keystrokes so `j` `j` doesn't arrive as one "jj" input.
const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

type Terminal = Parameters<Parameters<typeof test>[1]>[0]['terminal']

const screen = (terminal: Terminal) =>
  terminal
    .getViewableBuffer()
    .map((row) => row.join(''))
    .join('\n')

async function press(terminal: Terminal, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    terminal.write(key)
    await pause()
  }
}

// The last line of Ada's conversation, in the message pane only. Gamma's
// contains alpha's, so alpha's is told apart by what follows it.
const ALPHA_ADA = 'I will read them now.'
const BETA_ADA = 'I WILL READ THEM NOW.'
const GAMMA_ADA = 'I will read them now. (gamma)'

// Background accounts are seeded after the foreground: wait for the last
// section's rows before looking at the list.
async function ready(terminal: Terminal, last: 'beta' | 'gamma') {
  // gamma's rows contain alpha's names.
  await expect(terminal.getByText('Ada Byron', { strict: false })).toBeVisible()
  await expect(
    terminal.getByText(last === 'beta' ? 'ADA BYRON' : 'Design Sync (gamma)'),
  ).toBeVisible()
}

test.describe('two accounts: sidebar', () => {
  useAccounts(['alpha', 'beta'])
  test('account-unified: both sections under their headers', async ({ terminal }) => {
    await ready(terminal, 'beta')
    await expect(terminal.getByText('▾ alpha')).toBeVisible()
    await expect(terminal.getByText('▾ beta')).toBeVisible()
    // The account header rows carry the counts; no header-bar badge.
    expect(screen(terminal)).not.toContain('beta !')
    await expect(terminal).toMatchSnapshot()
  })
})

test.describe('two accounts: navigate and open', () => {
  useAccounts(['alpha', 'beta'])
  test('account-unified: j/k cross sections; Enter opens the row of its own account', async ({
    terminal,
  }) => {
    await ready(terminal, 'beta')
    // alpha header → Ada, Design Sync, Ops Channel → beta header → ADA BYRON.
    await press(terminal, 'j', 5)
    terminal.submit()
    await expect(terminal.getByText(BETA_ADA)).toBeVisible()
    await expect(terminal.getByText('beta · j/k msg')).toBeVisible()
    expect(screen(terminal)).not.toContain(ALPHA_ADA)
    // F.4: the empty composer names the account in front.
    await expect(terminal.getByText('Message ADA BYRON as beta')).toBeVisible()

    // Back to the list: the cursor stayed on beta's row through the swap,
    // so four rows up is alpha's Ada (same chat id).
    await press(terminal, 'h')
    await press(terminal, 'k', 4)
    terminal.submit()
    await expect(terminal.getByText(ALPHA_ADA)).toBeVisible()
    await expect(terminal.getByText('alpha · j/k msg')).toBeVisible()
    expect(screen(terminal)).not.toContain(BETA_ADA)
  })
})

test.describe('two accounts: collapse', () => {
  useAccounts(['alpha', 'beta'])
  test('account-unified: h collapses an account header, Enter expands it', async ({ terminal }) => {
    await ready(terminal, 'beta')
    // The cursor starts on alpha's header.
    await press(terminal, 'h')
    await expect(terminal.getByText('▸ alpha')).toBeVisible()
    await expect(terminal.getByText('Ada Byron')).not.toBeVisible()
    await expect(terminal.getByText('ADA BYRON')).toBeVisible()

    // Enter expands and moves to its first row: Enter again opens it.
    terminal.submit()
    await expect(terminal.getByText('▾ alpha')).toBeVisible()
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    await pause()
    terminal.submit()
    await expect(terminal.getByText(ALPHA_ADA)).toBeVisible()

    // h from one of beta's rows collapses beta and lands on its header.
    await press(terminal, 'h')
    await press(terminal, 'j', 4)
    await press(terminal, 'h')
    await expect(terminal.getByText('▸ beta')).toBeVisible()
    await expect(terminal.getByText('ADA BYRON')).not.toBeVisible()
    await press(terminal, 'l')
    await expect(terminal.getByText('ADA BYRON')).toBeVisible()
  })
})

test.describe('two accounts: filter', () => {
  useAccounts(['alpha', 'beta'])
  test('account-unified: a filter keeps the headers of accounts with a match', async ({
    terminal,
  }) => {
    await ready(terminal, 'beta')
    await press(terminal, '/')
    for (const ch of 'design') await press(terminal, ch)
    await expect(terminal.getByText('Design Sync')).toBeVisible()
    await expect(terminal.getByText('DESIGN SYNC')).toBeVisible()
    await expect(terminal.getByText('▾ alpha')).toBeVisible()
    await expect(terminal.getByText('▾ beta')).toBeVisible()
    await expect(terminal.getByText('Ada Byron')).not.toBeVisible()
    await expect(terminal.getByText('ADA BYRON')).not.toBeVisible()

    // Accept, then open beta's match: header, Design Sync, header, DESIGN SYNC.
    terminal.submit()
    await pause()
    await press(terminal, 'j', 3)
    terminal.submit()
    await expect(terminal.getByText('beta · j/k msg')).toBeVisible()
    // The filter stays through the swap.
    await expect(terminal.getByText('/ design', { strict: false })).toBeVisible()
  })
})

test.describe('two accounts: narrow terminal', () => {
  useAccounts(['alpha', 'beta'], { rows: 22, columns: 56 })
  test('account-unified: narrow terminal keeps the cursor row on screen', async ({ terminal }) => {
    await ready(terminal, 'beta')
    await expect(terminal.getByText('▾ alpha')).toBeVisible()
    // Down to beta's last chat, past the bottom of the pane.
    await press(terminal, 'j', 7)
    // The narrow pane wraps the label: OPS / CHANNEL.
    await expect(terminal.getByText('OPS')).toBeVisible()
    await expect(terminal.getByText('▾ beta')).toBeVisible()
    terminal.submit()
    await expect(terminal.getByText('beta · j/k msg')).toBeVisible()
  })
})

test.describe('three accounts', () => {
  useAccounts(['alpha', 'beta', 'gamma'], { rows: 40, columns: 100 })
  test('account-unified: three sections; Enter opens gamma’s copy of a shared chat id', async ({
    terminal,
  }) => {
    await ready(terminal, 'gamma')
    await expect(terminal.getByText('▾ alpha')).toBeVisible()
    await expect(terminal.getByText('▾ beta')).toBeVisible()
    await expect(terminal.getByText('▾ gamma')).toBeVisible()
    await expect(terminal).toMatchSnapshot()

    // 9 rows down: alpha's 3 chats, beta's header + 3, gamma's header + Ada.
    await press(terminal, 'j', 9)
    terminal.submit()
    await expect(terminal.getByText(GAMMA_ADA)).toBeVisible()
    await expect(terminal.getByText('gamma · j/k msg')).toBeVisible()
    expect(screen(terminal)).not.toContain(BETA_ADA)

    // A filter that only gamma's rows match drops the other headers.
    await press(terminal, 'h')
    await press(terminal, '/')
    for (const ch of 'gamma') await press(terminal, ch)
    await expect(terminal.getByText('▾ gamma')).toBeVisible()
    await expect(terminal.getByText('▾ alpha')).not.toBeVisible()
    await expect(terminal.getByText('▾ beta')).not.toBeVisible()
  })
})
