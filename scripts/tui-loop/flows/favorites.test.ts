/**
 * Flow: favorites (sidebar Favorites sections) and the account gap.
 *
 * concurrentAccounts on with the seeded accounts `alpha` and `beta` (beta
 * upper-cases names, topics and bodies). `f` moves a row into its account's
 * Favorites section; the cursor goes with it and Enter opens it. A non-zero
 * account gap keeps the cursor row on screen in a short pane.
 *
 * Each test gets its own config dir: favorites persist there.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { test, expect } from '@microsoft/tui-test'

function useAccounts(extra: Record<string, unknown>, size = { rows: 30, columns: 100 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-favorites-'))
  fs.mkdirSync(path.join(dir, 'teaminal'), { recursive: true })
  const file = path.join(dir, 'teaminal', 'config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      theme: 'dark',
      accounts: ['alpha', 'beta'],
      activeAccount: 'alpha',
      concurrentAccounts: true,
      ...extra,
    }),
  )
  test.use({
    program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
    env: { TEAMINAL_SEED: 'fixtures', TZ: 'UTC', XDG_CONFIG_HOME: dir },
    ...size,
  })
  return file
}

// Separate keystrokes so `j` `j` doesn't arrive as one "jj" input.
const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

type Terminal = Parameters<Parameters<typeof test>[1]>[0]['terminal']

const lines = (terminal: Terminal) => terminal.getViewableBuffer().map((row) => row.join(''))
const lineOf = (terminal: Terminal, text: string) =>
  lines(terminal).findIndex((l) => l.includes(text))

async function press(terminal: Terminal, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    terminal.write(key)
    await pause()
  }
}

async function ready(terminal: Terminal) {
  await expect(terminal.getByText('Ada Byron', { strict: false })).toBeVisible()
  await expect(terminal.getByText('ADA BYRON')).toBeVisible()
}

// Poll the config file until `predicate` holds (persist is async in the app).
async function waitForConfig(file: string, predicate: (cfg: any) => boolean): Promise<any> {
  const deadline = Date.now() + 5000
  for (;;) {
    let cfg: any = null
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {}
    if (predicate(cfg) || Date.now() > deadline) return cfg
    await pause(100)
  }
}

test.describe('f: per-account favorites', () => {
  const file = useAccounts({})
  test('favorites: f moves a row into its account’s Favorites; Enter opens it', async ({
    terminal,
  }) => {
    await ready(terminal)
    // alpha header → Ada Byron → Design Sync.
    await press(terminal, 'j', 2)
    await press(terminal, 'f')
    await expect(terminal.getByText('▾ Favorites')).toBeVisible()
    // Favorites sits inside alpha's block, above its other rows, and holds
    // Design Sync; beta is untouched.
    const alpha = lineOf(terminal, '▾ alpha')
    const favorites = lineOf(terminal, '▾ Favorites')
    const design = lineOf(terminal, 'Design Sync')
    const ada = lineOf(terminal, 'Ada Byron')
    if (!(alpha < favorites && favorites < design && design < ada))
      throw new Error(`unexpected order\n${lines(terminal).join('\n')}`)
    const cfg = await waitForConfig(file, (c) => c?.favoritesByAccount?.alpha?.length === 1)
    assert.deepEqual(cfg?.favoritesByAccount, { alpha: ['chat:seed-chat-design-sync'] })

    // The cursor moved with the row: Enter opens Design Sync in alpha.
    terminal.submit()
    await expect(terminal.getByText('alpha · j/k msg')).toBeVisible()
    await expect(terminal.getByText('Two compact layout options landed.')).toBeVisible()
  })
})

test.describe('Ctrl+F: cross-account favorites', () => {
  const file = useAccounts({})
  test('favorites: f, then Ctrl+F moves a background account’s row to the top block', async ({
    terminal,
  }) => {
    await ready(terminal)
    // alpha header, Ada, Design Sync, Ops Channel, beta header, ADA, DESIGN SYNC.
    await press(terminal, 'j', 6)
    await press(terminal, 'f')
    await expect(terminal.getByText('▾ Favorites')).toBeVisible()
    if (!(lineOf(terminal, '▾ beta') < lineOf(terminal, '▾ Favorites')))
      throw new Error(`Favorites not inside beta\n${lines(terminal).join('\n')}`)

    // Ctrl+F: the same row moves to the block above every account, named
    // with its account; beta's own Favorites section is empty and goes.
    await press(terminal, '\x06')
    await expect(terminal.getByText('DESIGN SYNC · beta')).toBeVisible()
    const top = lineOf(terminal, '▾ Favorites')
    if (!(top < lineOf(terminal, '▾ alpha') && top < lineOf(terminal, 'DESIGN SYNC · beta')))
      throw new Error(`block not on top\n${lines(terminal).join('\n')}`)
    assert.equal(lines(terminal).filter((l) => l.includes('▾ Favorites')).length, 1)
    const cfg = await waitForConfig(file, (c) => c?.crossAccountFavorites?.beta?.length === 1)
    assert.deepEqual(cfg?.crossAccountFavorites, { beta: ['chat:seed-chat-design-sync'] })
    assert.deepEqual(cfg?.favoritesByAccount, { beta: ['chat:seed-chat-design-sync'] })

    // No account switch so far; Enter opens the row in beta.
    await expect(terminal.getByText('beta · j/k msg')).not.toBeVisible()
    terminal.submit()
    await expect(terminal.getByText('beta · j/k msg')).toBeVisible()
    await expect(terminal.getByText('TWO COMPACT LAYOUT OPTIONS LANDED.')).toBeVisible()
  })
})

test.describe('account gap', () => {
  // 24 rows: a 15-row list. alpha's block (7) + gap (2) + beta's header and
  // chats (7) is 16, so beta's last chat starts below the pane.
  useAccounts({ themeOverrides: { layout: { accountGap: 2 } } }, { rows: 24, columns: 100 })
  test('favorites: a non-zero account gap keeps the cursor row on screen', async ({ terminal }) => {
    await ready(terminal)
    // Two blank list rows above beta's header.
    const beta = lineOf(terminal, '▾ beta')
    const listCell = (l: string) => l.slice(1, 20).trim()
    assert.equal(listCell(lines(terminal)[beta - 1]!), '')
    assert.equal(listCell(lines(terminal)[beta - 2]!), '')
    assert.notEqual(listCell(lines(terminal)[beta - 3]!), '')
    await expect(terminal.getByText('OPS CHANNEL')).not.toBeVisible()
    // Down to beta's last chat, past the bottom of the pane.
    await press(terminal, 'j', 7)
    await expect(terminal.getByText('OPS CHANNEL')).toBeVisible()
    terminal.submit()
    await expect(terminal.getByText('beta · j/k msg')).toBeVisible()
    await expect(
      terminal.getByText('GOOD, LEAVE THE MONITOR OPEN.', { strict: false }),
    ).toBeVisible()
  })
})
