/**
 * Flow: mouse (settings.mouse)
 *
 * With the setting on, a left click on a sidebar row opens it, a click on a
 * header collapses / expands it, and a click on a background account's row
 * brings that account to the front. With it off, the mouse reports the
 * harness writes anyway never show up as text.
 *
 * tui-test's mousePress takes 0-based cells and writes SGR reports straight
 * to the pty, whatever modes the app enabled.
 *
 * Each test gets its own config dir: flows run in parallel and the settings
 * differ.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

function useConfig(config: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-mouse-'))
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

const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms))

type Terminal = Parameters<Parameters<typeof test>[1]>[0]['terminal']

const lines = (terminal: Terminal) => terminal.getViewableBuffer().map((row) => row.join(''))
const screen = (terminal: Terminal) => lines(terminal).join('\n')

// The first cell of `text` in the sidebar (left of column 40).
function cellOf(terminal: Terminal, text: string): { x: number; y: number } {
  const ls = lines(terminal)
  for (let y = 0; y < ls.length; y++) {
    const x = ls[y]!.indexOf(text)
    if (x >= 0 && x < 40) return { x, y }
  }
  throw new Error(`"${text}" is not in the sidebar:\n${ls.join('\n')}`)
}

async function click(terminal: Terminal, text: string) {
  const { x, y } = cellOf(terminal, text)
  terminal.mousePress(x + 1, y)
  await pause()
}

// The last message of Design Sync, in the message pane only.
const DESIGN_SYNC_LAST = 'The second one scans faster.'

test.describe('click a row', () => {
  useConfig({ mouse: true })
  test('mouse click-row: a click opens the conversation', async ({ terminal }) => {
    await expect(terminal.getByText('Design Sync')).toBeVisible()
    expect(screen(terminal)).not.toContain(DESIGN_SYNC_LAST)
    await click(terminal, 'Design Sync')
    await expect(terminal.getByText(DESIGN_SYNC_LAST)).toBeVisible()
    expect(screen(terminal)).not.toContain('[<')
  })
})

test.describe('click a header', () => {
  useConfig({ mouse: true, chatListGroupByType: true })
  test('mouse click-header: collapses, then expands, a section', async ({ terminal }) => {
    await expect(terminal.getByText('▾ Groups')).toBeVisible()
    await expect(terminal.getByText('Design Sync')).toBeVisible()
    await click(terminal, '▾ Groups')
    await expect(terminal.getByText('▸ Groups (2)')).toBeVisible()
    await expect(terminal.getByText('Design Sync')).not.toBeVisible()
    await click(terminal, '▸ Groups')
    await expect(terminal.getByText('▾ Groups')).toBeVisible()
    await expect(terminal.getByText('Design Sync')).toBeVisible()
    // Nothing opened along the way.
    expect(screen(terminal)).not.toContain(DESIGN_SYNC_LAST)
  })
})

test.describe('click a background account’s row', () => {
  useConfig({
    mouse: true,
    accounts: ['alpha', 'beta'],
    activeAccount: 'alpha',
    concurrentAccounts: true,
  })
  test('mouse click-background-account: the row’s account comes to the front', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Ada Byron', { strict: false })).toBeVisible()
    await expect(terminal.getByText('ADA BYRON')).toBeVisible()
    await click(terminal, 'ADA BYRON')
    await expect(terminal.getByText('I WILL READ THEM NOW.')).toBeVisible()
    await expect(terminal.getByText('beta · j/k msg')).toBeVisible()
  })
})

test.describe('mouse off', () => {
  useConfig({ mouse: false })
  test('mouse filter-negative: reports never type into the pane or the composer', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    terminal.submit()
    await expect(terminal.getByText('I will read them now.')).toBeVisible()
    terminal.write('\t')
    await pause()
    // In the conversation pane, then in the composer (bottom rows).
    terminal.mousePress(60, 10)
    await pause()
    terminal.mousePress(60, 26)
    await pause()
    terminal.write('\x1b[<65;60;10M\x1b[<64;60;10M')
    await pause()
    // A row click and the wheel over the sidebar, where they would act if on.
    await click(terminal, 'Design Sync')
    await wheel(terminal, 'down', 5, 10)
    expect(screen(terminal)).not.toContain('[<')
    expect(screen(terminal)).not.toContain(';10M')
    // The composer is still empty: its prompt line holds nothing but `>`.
    const prompt = lines(terminal).find((l) => l.startsWith('│ >'))
    expect(prompt?.slice(3).replace('│', '').trim()).toBe('')
    // Nothing opened from the list either: the click was not a click.
    expect(screen(terminal)).not.toContain(DESIGN_SYNC_LAST)
  })
})

// ---------------------------------------------------------------------------
// Wheel: tui-test has no helper; 64 is up, 65 down, cells 1-based.
// ---------------------------------------------------------------------------

async function wheel(terminal: Terminal, dir: 'up' | 'down', x: number, y: number, times = 1) {
  for (let i = 0; i < times; i++) {
    terminal.write(`\x1b[<${dir === 'up' ? 64 : 65};${x + 1};${y + 1}M`)
    await pause()
  }
}

// Screen row of the focused message's marker (`>`) in the conversation pane,
// or -1. The pane starts right of the sidebar; the composer prompt is lower.
function markerRow(terminal: Terminal): number {
  return lines(terminal).findIndex((l, y) => y < 25 && /^│ ?>/.test(l.slice(28)))
}

const LIST = { x: 5, y: 10 }
const PANE = { x: 60, y: 10 }

test.describe('wheel', () => {
  useConfig({ mouse: true })

  test('mouse wheel-list: one report moves the cursor one row; Enter opens it', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Design Sync')).toBeVisible()
    await wheel(terminal, 'down', LIST.x, LIST.y)
    terminal.submit()
    await expect(terminal.getByText(DESIGN_SYNC_LAST)).toBeVisible()
  })

  test('mouse wheel-list boundaries: up at the top and down at the bottom stay put', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Design Sync')).toBeVisible()
    await wheel(terminal, 'up', LIST.x, LIST.y, 2)
    terminal.submit()
    await expect(
      terminal.getByText('The launch notes are ready for review.', { strict: false }),
    ).toBeVisible()
    expect(screen(terminal)).toContain('I will read them now.')
    terminal.write('h')
    await pause()
    await wheel(terminal, 'down', LIST.x, LIST.y, 5)
    terminal.submit()
    await expect(terminal.getByText('Good, leave the monitor open.')).toBeVisible()
  })

  test('mouse wheel-pane: the marker moves one message; the top and bottom hold', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    terminal.submit()
    await expect(terminal.getByText('I will read them now.')).toBeVisible()
    await pause()
    const last = markerRow(terminal)
    expect(last).toBeGreaterThan(0)
    await wheel(terminal, 'up', PANE.x, PANE.y)
    const first = markerRow(terminal)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(last)
    // At the top: older history is unavailable in the seed, so nothing moves.
    await wheel(terminal, 'up', PANE.x, PANE.y)
    expect(markerRow(terminal)).toBe(first)
    await wheel(terminal, 'down', PANE.x, PANE.y, 3)
    expect(markerRow(terminal)).toBe(last)
  })

  test('mouse wheel-composer: the wheel leaves the composer and keeps the draft', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    terminal.submit()
    await expect(terminal.getByText('I will read them now.')).toBeVisible()
    terminal.write('\t')
    await pause()
    terminal.write('draft text')
    await pause()
    await expect(terminal.getByText('draft text')).toBeVisible()
    const last = markerRow(terminal)
    await wheel(terminal, 'up', PANE.x, PANE.y)
    // Back in the list zone: the marker shows and moved up.
    const now = markerRow(terminal)
    expect(now).toBeGreaterThan(0)
    if (last > 0) expect(now).toBeLessThan(last)
    terminal.write('\t')
    await pause()
    await expect(terminal.getByText('draft text')).toBeVisible()
  })

  test('mouse wheel-suppressed: a modal, the new-chat prompt and resize mode ignore the wheel', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Design Sync')).toBeVisible()
    // Menu open (Esc), wheel, close.
    terminal.write('\x1b')
    await pause()
    await wheel(terminal, 'down', LIST.x, LIST.y)
    terminal.write('\x1b')
    await pause()
    // New-chat prompt (p), wheel, close.
    terminal.write('p')
    await pause()
    await wheel(terminal, 'down', LIST.x, LIST.y)
    terminal.write('\x1b')
    await pause()
    // Resize mode (Ctrl+X), wheel, leave.
    terminal.write('\x18')
    await pause()
    await wheel(terminal, 'down', LIST.x, LIST.y)
    terminal.write('\x1b')
    await pause()
    // The cursor never moved: Enter opens the first chat.
    terminal.submit()
    await expect(terminal.getByText('I will read them now.')).toBeVisible()
    expect(screen(terminal)).not.toContain(DESIGN_SYNC_LAST)
  })

  // The synthetic row is not clicked here: the new-chat prompt would search
  // the directory with a real client. activateListRow's tests cover it.
  test('mouse filter-rows: no matches and the synthetic row: the wheel opens nothing', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('Design Sync')).toBeVisible()
    terminal.write('/')
    await pause()
    terminal.write('zz9')
    await pause()
    await expect(terminal.getByText('no matches')).toBeVisible()
    await wheel(terminal, 'down', LIST.x, LIST.y)
    await wheel(terminal, 'up', LIST.x, LIST.y)
    for (let i = 0; i < 3; i++) {
      terminal.write('\x7f')
      await pause()
    }
    terminal.write('Kari')
    await pause()
    // Wrapped in the narrow sidebar: `Create chat with` / `"Kari"`.
    await expect(terminal.getByText('Create chat with')).toBeVisible()
    await expect(terminal.getByText('"Kari"')).toBeVisible()
    await wheel(terminal, 'down', LIST.x, LIST.y)
    await wheel(terminal, 'up', LIST.x, LIST.y)
    expect(screen(terminal)).not.toContain('New chat')
    expect(screen(terminal)).not.toContain('[<')
    await expect(terminal.getByText('/ Kari')).toBeVisible()
  })
})
