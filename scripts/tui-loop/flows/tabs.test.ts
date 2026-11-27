/**
 * Flow: conversation tabs (conversationMode 'tabs')
 *
 * Single mode (the default) has no tab bar. Ctrl+T flips to tabs; every
 * conversation opened then gets a tab on the message pane's top line. `[` /
 * `]` / a digit switch tabs, a draft stays with its conversation, Ctrl+W
 * closes a tab, and with two fixture accounts open each has its own tab.
 * Nothing is ever sent: the draft is left unsent.
 *
 * Each test gets its own config dir: Ctrl+T persists conversationMode.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

function useConfig(config: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-tabs-'))
  fs.mkdirSync(path.join(dir, 'teaminal'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'teaminal', 'config.json'),
    JSON.stringify({ theme: 'dark', ...config }),
  )
  test.use({
    program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
    env: { TEAMINAL_SEED: 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: dir },
    rows: 30,
    columns: 100,
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

async function press(terminal: Terminal, key: string) {
  terminal.write(key)
  await pause()
}

// The newest message of each fixture chat, shown only in its message pane.
const ADA = 'I will read them now.'
const DESIGN = 'The second one scans faster.'
const OPS = 'Good, leave the monitor open.'
const BAR = ' 1 Ada Byron │ 2 Design Sync │ 3 Ops Channel '

// From the list: open the row under the cursor, then back to the list and
// one row down, three times (Ada Byron, Design Sync, Ops Channel).
async function openThree(terminal: Terminal) {
  for (const [i, text] of [ADA, DESIGN, OPS].entries()) {
    terminal.submit()
    await expect(terminal.getByText(text)).toBeVisible()
    if (i < 2) {
      await press(terminal, 'h')
      await press(terminal, 'j')
    }
  }
}

test.describe('tabs: one account', () => {
  useConfig({})

  test('tabs: single mode has no bar; Ctrl+T, three tabs, [ ] and digits switch', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    // Single mode: Enter replaces the open conversation, no tab bar.
    await openThree(terminal)
    let s = screen(terminal)
    expect(s).not.toContain('1 Ada Byron │')
    expect(s).not.toContain(ADA)
    await press(terminal, ']')
    await press(terminal, '1')
    expect(screen(terminal)).toContain(OPS)

    // Tabs mode: the open conversation becomes the first tab.
    terminal.keyPress('t', { ctrl: true })
    await expect(terminal.getByText(' 1 Ops Channel ')).toBeVisible()
    await press(terminal, 'h')
    await press(terminal, 'k')
    await press(terminal, 'k')
    await openThree(terminal)
    // Ops Channel already had a tab: Enter on its row switched to it.
    await expect(terminal.getByText(' 1 Ops Channel │ 2 Ada Byron │ 3 Design Sync ')).toBeVisible()
    s = screen(terminal)
    expect(s).toContain(OPS)
    expect(s).not.toContain(DESIGN)

    // [ wraps from the first tab to the last.
    await press(terminal, '[')
    await expect(terminal.getByText(DESIGN)).toBeVisible()
    await press(terminal, '[')
    await expect(terminal.getByText(ADA)).toBeVisible()
    await press(terminal, ']')
    await expect(terminal.getByText(DESIGN)).toBeVisible()
    // ] wraps from the last tab to the first.
    await press(terminal, ']')
    await expect(terminal.getByText(OPS)).toBeVisible()
    await press(terminal, '2')
    await expect(terminal.getByText(ADA)).toBeVisible()
    // Still three tabs: switching opened none.
    expect(screen(terminal)).toContain(' 1 Ops Channel │ 2 Ada Byron │ 3 Design Sync ')

    // Back to single mode: no bar, the open conversation stays.
    terminal.keyPress('t', { ctrl: true })
    await pause()
    s = screen(terminal)
    expect(s).not.toContain('│ 2 Ada Byron')
    expect(s).toContain(ADA)
  })

  test('tabs: a draft stays in its tab; Ctrl+W deletes a word in the composer, closes a tab outside it', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    terminal.keyPress('t', { ctrl: true })
    await pause()
    await openThree(terminal)
    await expect(terminal.getByText(BAR)).toBeVisible()

    // A draft in Ada's tab, typed with the tab keys: they type in the
    // composer, and Ctrl+W deletes a word there.
    await press(terminal, '1')
    await expect(terminal.getByText(ADA)).toBeVisible()
    await press(terminal, '\t')
    terminal.write('see [2] and 3 more')
    await expect(terminal.getByText('see [2] and 3 more')).toBeVisible()
    terminal.keyPress('w', { ctrl: true })
    await pause()
    let s = screen(terminal)
    expect(s).toContain('see [2] and 3')
    expect(s).not.toContain('3 more')
    expect(s).toContain(BAR)
    await press(terminal, '\t')

    // Away and back: the draft is Ada's only.
    await press(terminal, '3')
    await expect(terminal.getByText(OPS)).toBeVisible()
    expect(screen(terminal)).not.toContain('see [2] and 3')
    await press(terminal, '[')
    await expect(terminal.getByText(DESIGN)).toBeVisible()
    expect(screen(terminal)).not.toContain('see [2] and 3')
    await press(terminal, '1')
    await expect(terminal.getByText('see [2] and 3')).toBeVisible()
    expect(screen(terminal)).toContain(ADA)

    // Close Ada's tab (the first): the next one takes over.
    terminal.keyPress('w', { ctrl: true })
    await expect(terminal.getByText(' 1 Design Sync │ 2 Ops Channel ')).toBeVisible()
    s = screen(terminal)
    expect(s).toContain(DESIGN)
    expect(s).not.toContain('Ada Byron │')
    // Close the last one (Ops): the previous takes over; then the last tab.
    await press(terminal, '2')
    await expect(terminal.getByText(OPS)).toBeVisible()
    terminal.keyPress('w', { ctrl: true })
    await expect(terminal.getByText('2 Ops Channel')).not.toBeVisible()
    await expect(terminal.getByText(DESIGN)).toBeVisible()
    expect(screen(terminal)).toContain(' 1 Design Sync ')
    terminal.keyPress('w', { ctrl: true })
    await expect(terminal.getByText('Select a chat or channel')).toBeVisible()
    expect(screen(terminal)).not.toContain(' 1 Design Sync ')
  })
})

test.describe('tabs: two accounts', () => {
  useConfig({
    accounts: ['alpha', 'beta'],
    activeAccount: 'alpha',
    concurrentAccounts: true,
    conversationMode: 'tabs',
  })

  test('tabs: a tab per account; switching brings its account to the front', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Ada Byron', { strict: false })).toBeVisible()
    await expect(terminal.getByText('ADA BYRON')).toBeVisible()
    // The cursor starts on alpha's header: down to Ada Byron, open it.
    await press(terminal, 'j')
    terminal.submit()
    await expect(terminal.getByText(ADA)).toBeVisible()
    // Back to the list, down to beta's Ada Byron, open it.
    await press(terminal, 'h')
    for (let i = 0; i < 4; i++) await press(terminal, 'j')
    terminal.submit()
    await expect(terminal.getByText(ADA.toUpperCase())).toBeVisible()
    await expect(
      terminal.getByText(' 1 Ada Byron · alpha │ 2 ADA BYRON · beta ', { strict: false }),
    ).toBeVisible()

    await press(terminal, '1')
    await expect(terminal.getByText(ADA)).toBeVisible()
    let s = screen(terminal)
    expect(s).not.toContain(ADA.toUpperCase())
    await press(terminal, ']')
    await expect(terminal.getByText(ADA.toUpperCase())).toBeVisible()
    s = screen(terminal)
    expect(s).not.toContain(ADA)
    expect(s).toContain(' 1 Ada Byron · alpha │ 2 ADA BYRON · beta ')
  })
})
