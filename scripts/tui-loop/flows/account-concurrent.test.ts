/**
 * Flow: account-concurrent (M2 Phase E.4)
 *
 * concurrentAccounts on, two seeded accounts that share every id: `beta`
 * upper-cases names, topics and bodies. Both run at once; picking an account
 * in the Accounts modal swaps it to the foreground instantly, and it comes
 * back on the conversation that was open in it. Any text from the other
 * account on screen after a swap is a cross-account leak.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-concurrent-'))
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

// Separate keystrokes so `j` `j` doesn't arrive as one "jj" input.
const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

const screen = (terminal: { getViewableBuffer(): string[][] }) =>
  terminal
    .getViewableBuffer()
    .map((row) => row.join(''))
    .join('\n')

// Message-pane-only lines (not in the chat list previews).
const ALPHA_ADA = 'I will read them now.'
const BETA_DESIGN = 'THE SECOND ONE SCANS FASTER.'

// Esc → menu, j → Accounts, Enter → modal, `down` rows to the account, Enter.
type Terminal = Parameters<Parameters<typeof test>[1]>[0]['terminal']
async function switchTo(terminal: Terminal, down: number) {
  terminal.keyEscape()
  await expect(terminal.getByText('Accounts')).toBeVisible()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('Enter switch')).toBeVisible()
  for (let i = 0; i < down; i++) {
    terminal.write('j')
    await pause()
  }
  terminal.submit()
}

function expectOnly(terminal: Terminal, account: 'alpha' | 'beta') {
  const out = screen(terminal)
  if (account === 'beta') {
    expect(out).not.toContain('Ada Byron')
    expect(out).not.toContain('Design Sync')
    expect(out).not.toContain(ALPHA_ADA)
  } else {
    expect(out).not.toContain('ADA BYRON')
    expect(out).not.toContain('DESIGN SYNC')
    expect(out).not.toContain(BETA_DESIGN)
  }
}

test('account-concurrent: instant switch lands on the conversation that was open', async ({
  terminal,
}) => {
  // alpha in front: open Ada's chat.
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  terminal.submit()
  await expect(terminal.getByText(ALPHA_ADA)).toBeVisible()

  // beta: already running, swapped in with its own (list) focus.
  await switchTo(terminal, 1)
  await expect(terminal.getByText('ADA BYRON')).toBeVisible()
  expectOnly(terminal, 'beta')
  // Open DESIGN SYNC in beta.
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText(BETA_DESIGN)).toBeVisible()
  expectOnly(terminal, 'beta')

  // Back to alpha: Ada's chat is open again without pressing Enter.
  await switchTo(terminal, 0)
  await expect(terminal.getByText(ALPHA_ADA)).toBeVisible()
  expectOnly(terminal, 'alpha')

  // And beta comes back on DESIGN SYNC.
  await switchTo(terminal, 1)
  await expect(terminal.getByText(BETA_DESIGN)).toBeVisible()
  expectOnly(terminal, 'beta')

  // End on alpha, so the persisted activeAccount is the starting one again.
  await switchTo(terminal, 0)
  await expect(terminal.getByText(ALPHA_ADA)).toBeVisible()
  expectOnly(terminal, 'alpha')
})
