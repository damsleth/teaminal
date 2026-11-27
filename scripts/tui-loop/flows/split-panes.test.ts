/**
 * Flow: split-panes
 *
 * Two conversations side by side. `v` on a list row opens it in the other
 * (passive) pane, on the right; Enter / l opens a row in the active pane;
 * `w` switches panes, `o` keeps one. Below 72 columns of pane area only the
 * active pane shows and `w` toggles; Ctrl+B gives the panes the full width.
 *
 * Render only: this flow never submits the composer. Seeded mode has no
 * session, and a send would fall back to a real client (owa-piggy). Rows are
 * opened with `l`, not Enter, so a stray composer focus can never send.
 *
 * Checks are scoped to one pane: at 120 columns the chat list is 34 wide
 * (computeLayout), and the 86-column pane area splits 43 / 43
 * (splitPaneWidths): the left pane is columns 34-76, the right 77-119. Only
 * the timeline rows count (below the 3-row header bar, above the composer),
 * so the sidebar, composer and status bar never match.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

function useConfig(
  opts: { columns?: number; seed?: string; config?: Record<string, unknown> } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-split-'))
  fs.mkdirSync(path.join(dir, 'teaminal'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'teaminal', 'config.json'),
    JSON.stringify({
      theme: 'dark',
      chatListPreviewLines: 0,
      messageAvatars: 'off',
      ...opts.config,
    }),
  )
  test.use({
    program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
    env: { TEAMINAL_SEED: opts.seed ?? 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: dir },
    rows: 30,
    columns: opts.columns ?? 120,
  })
}

const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

type Terminal = Parameters<Parameters<typeof test>[1]>[0]['terminal']
async function press(terminal: Terminal, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    terminal.write(key)
    await pause()
  }
}

// Timeline rows: below the header bar (rows 0-2), above the composer box
// (rows 26-28 at 30 rows) and the status bar.
const TIMELINE_ROWS: [number, number] = [3, 26]
function region(terminal: Terminal, from: number, to: number): string {
  return terminal
    .getViewableBuffer()
    .slice(...TIMELINE_ROWS)
    .map((row) => row.slice(from, to).join(''))
    .join('\n')
}
const leftPane = (t: Terminal) => region(t, 34, 77)
const rightPane = (t: Terminal) => region(t, 77, 120)
// The whole conversation region right of a `list`-column chat list.
const conversation = (t: Terminal, list = 34) => region(t, list, 200)
const composerRows = (t: Terminal) =>
  t
    .getViewableBuffer()
    .slice(26, 29)
    .map((row) => row.join(''))
    .join('\n')

// The first message of each chat: never a preview line.
const ADA_FIRST = 'I will read them now.'
const DESIGN_FIRST = 'Two compact layout options landed.'
const up = (t: string) => t.toUpperCase()

// v on Ada Byron (the first row) opens it on the right; j, l opens Design
// Sync in the active pane on the left. Too narrow, the right pane is hidden
// and the empty active pane names it.
async function openSplit(terminal: Terminal, wide = true) {
  await expect(terminal.getByText('Design Sync')).toBeVisible()
  await press(terminal, 'v')
  await expect(terminal.getByText(wide ? ADA_FIRST : 'other pane ⇆ Ada')).toBeVisible()
  await press(terminal, 'j')
  await press(terminal, 'l')
  await expect(terminal.getByText(DESIGN_FIRST)).toBeVisible()
}

test.describe('wide', () => {
  useConfig()

  test('split-open: each pane shows its own conversation and title', async ({ terminal }) => {
    await openSplit(terminal)
    const left = leftPane(terminal)
    const right = rightPane(terminal)
    expect(right).toContain(ADA_FIRST)
    expect(right).not.toContain(DESIGN_FIRST)
    expect(right).toContain('Ada Byron')
    expect(left).toContain(DESIGN_FIRST)
    expect(left).not.toContain(ADA_FIRST)
    expect(left).toContain('Design Sync')
    // The composer names its target while split.
    await press(terminal, '\t')
    await expect(terminal.getByText('Message Design Sync')).toBeVisible()
    await press(terminal, '\t')
  })

  test('split-switch-drafts: a draft stays with its conversation across w', async ({
    terminal,
  }) => {
    await openSplit(terminal)
    await press(terminal, '\t')
    terminal.write('draft one')
    await pause()
    await expect(terminal.getByText('draft one')).toBeVisible()
    await press(terminal, '\x1b')
    await press(terminal, 'w')
    await press(terminal, '\t')
    await expect(terminal.getByText('Message Ada Byron')).toBeVisible()
    expect(composerRows(terminal)).not.toContain('draft one')
    await press(terminal, '\x1b')
    await press(terminal, 'w')
    await press(terminal, '\t')
    await expect(terminal.getByText('draft one')).toBeVisible()
    expect(composerRows(terminal)).toContain('draft one')
    await press(terminal, '\x1b')
  })

  test('split-close: o keeps the active pane', async ({ terminal }) => {
    await openSplit(terminal)
    await press(terminal, 'o')
    await pause()
    const out = conversation(terminal)
    expect(out).toContain(DESIGN_FIRST)
    expect(out).not.toContain(ADA_FIRST)
  })

  test('split-palette: Close other pane from the command palette', async ({ terminal }) => {
    await openSplit(terminal)
    await press(terminal, '\x10')
    terminal.write('close other pane')
    await expect(terminal.getByText('Close other pane')).toBeVisible()
    await press(terminal, '\r')
    await pause()
    const out = conversation(terminal)
    expect(out).toContain(DESIGN_FIRST)
    expect(out).not.toContain(ADA_FIRST)
  })

  test('split-close-empty: h, then o keeps the other conversation', async ({ terminal }) => {
    await openSplit(terminal)
    await press(terminal, 'h')
    await expect(terminal.getByText('Enter opens here')).toBeVisible()
    await press(terminal, 'o')
    await pause()
    const out = conversation(terminal)
    expect(out).toContain(ADA_FIRST)
    expect(out).not.toContain(DESIGN_FIRST)
    expect(out).not.toContain('Enter opens here')
  })

  test('split-same-conv: opening the other pane row switches panes', async ({ terminal }) => {
    await openSplit(terminal)
    await press(terminal, 'h')
    // Back up to Ada Byron and open it: the panes switch, nothing moves.
    await press(terminal, 'k')
    await press(terminal, 'l')
    await pause()
    const left = leftPane(terminal)
    const right = rightPane(terminal)
    expect(right).toContain(ADA_FIRST)
    expect(left).not.toContain(ADA_FIRST)
    expect(left).toContain('Empty pane')
    expect(right).toMatch(/│ ?>/)
    expect(left).not.toMatch(/│ ?>/)
  })
})

test.describe('narrow', () => {
  useConfig({ columns: 80 })

  test('split-narrow: one pane shows, w toggles, Ctrl+B shows both', async ({ terminal }) => {
    await openSplit(terminal, false)
    // 80 columns: a 24-column list leaves 56, under the 72 a split needs.
    const has = (out: string) => [out.includes(ADA_FIRST), out.includes(DESIGN_FIRST)]
    expect(has(conversation(terminal, 24))).toEqual([false, true])
    // The title names the hidden conversation.
    await expect(terminal.getByText('⇆ Ada Byron')).toBeVisible()
    await press(terminal, 'w')
    await pause()
    expect(has(conversation(terminal, 24))).toEqual([true, false])
    // Ctrl+B: the conversation takes the full 80 columns, two 40-column panes.
    await press(terminal, '\x02')
    await pause()
    expect(has(conversation(terminal, 0))).toEqual([true, true])
    expect(region(terminal, 40, 80)).toContain(ADA_FIRST)
    expect(region(terminal, 0, 40)).toContain(DESIGN_FIRST)
  })
})

test.describe('two accounts', () => {
  useConfig({
    config: { accounts: ['alpha', 'beta'], activeAccount: 'alpha', concurrentAccounts: true },
  })

  test("split-account-swap: opening another account's row closes the split", async ({
    terminal,
  }) => {
    await expect(terminal.getByText(up('Design Sync'))).toBeVisible()
    // The cursor starts on alpha's header: Ada Byron, then Design Sync.
    await press(terminal, 'j')
    await press(terminal, 'v')
    await press(terminal, 'j')
    await press(terminal, 'l')
    await expect(terminal.getByText(DESIGN_FIRST)).toBeVisible()
    expect(rightPane(terminal)).toContain(ADA_FIRST)
    // h empties the active pane (the list gets j / k back); then Ops Channel,
    // beta's header, beta's Ada Byron: opening it brings beta forward.
    await press(terminal, 'h')
    await press(terminal, 'j', 3)
    await press(terminal, 'l')
    await expect(terminal.getByText(up(ADA_FIRST))).toBeVisible()
    const out = conversation(terminal)
    expect(out).toContain(up(ADA_FIRST))
    expect(out).not.toContain(ADA_FIRST)
    expect(out).not.toContain(DESIGN_FIRST)
    expect(out).not.toContain(up(DESIGN_FIRST))
  })
})

test.describe('channels', () => {
  useConfig({ seed: 'channels' })

  test('split-thread: a thread beside a chat, then beside its own channel', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('# Launch')).toBeVisible()
    await press(terminal, 'v')
    // Design Sync, Ops Channel, then the channel; the cursor starts on the
    // newest root, so t opens its thread.
    await press(terminal, 'j', 3)
    await press(terminal, 'l')
    await expect(terminal.getByText('Release notes draft is up.')).toBeVisible()
    await press(terminal, 't')
    await expect(terminal.getByText('Looks good to ship.')).toBeVisible()
    let left = leftPane(terminal)
    expect(left).toContain('Looks good to ship.')
    expect(left).not.toContain('Venue for the offsite is booked.')
    expect(rightPane(terminal)).toContain(ADA_FIRST)

    // v sends the thread to the other pane; l reopens the channel here.
    await press(terminal, 'v')
    await press(terminal, 'l')
    await expect(terminal.getByText('Venue for the offsite is booked.')).toBeVisible()
    left = leftPane(terminal)
    const right = rightPane(terminal)
    expect(left).toContain('Venue for the offsite is booked.')
    expect(left).toContain('2+ replies')
    expect(left).not.toContain('Looks good to ship.')
    expect(right).toContain('Looks good to ship.')
    expect(right).toContain('Added the migration section.')
    expect(right).not.toContain('Venue for the offsite is booked.')
    expect(right).not.toContain(ADA_FIRST)
  })
})
