/**
 * Flow: channel-threads
 *
 * TEAMINAL_SEED=channels adds one team channel to the fixtures: two roots
 * (the newer with two replies, the older with one) and a reply whose root is
 * not loaded. The channel view lists roots only, with "N+" reply badges (the
 * cache is incomplete); `t` on the focused root (the newest, where the cursor
 * starts) opens its thread; `h` goes back to the channel.
 *
 * Render only: this flow never submits the composer. Seeded mode has no
 * session, and a send would fall back to a real client (owa-piggy). Rows are
 * opened with `l`, not Enter, so a stray composer focus can never send.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

function useConfig(extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-channels-'))
  fs.mkdirSync(path.join(dir, 'teaminal'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'teaminal', 'config.json'),
    // No avatars: their fetch would go through the seeded fallback client.
    JSON.stringify({ theme: 'dark', messageAvatars: 'off', ...extra }),
  )
  test.use({
    program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
    env: { TEAMINAL_SEED: 'channels', TZ: 'UTC', XDG_CONFIG_HOME: dir },
    rows: 30,
    columns: 100,
  })
}

// Separate keystrokes so `j` `j` doesn't arrive as one "jj" input.
const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

type Terminal = Parameters<Parameters<typeof test>[1]>[0]['terminal']
async function press(terminal: Terminal, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    terminal.write(key)
    await pause()
  }
}

// The screen right of the chat list (message pane, composer, status bar).
const LIST_PANE_COLS = 28
const pane = (terminal: Terminal) =>
  terminal
    .getViewableBuffer()
    .map((row) => row.slice(LIST_PANE_COLS).join(''))
    .join('\n')

const ROOT_OLD = 'Venue for the offsite is booked.'
const REPLY_OLD = 'Great, I will sort the travel.'
const ROOT_NEW = 'Release notes draft is up.'
const REPLIES_NEW = ['Added the migration section.', 'Looks good to ship.']
const ORPHAN = 'Picking up the old thread here.'
const up = (t: string) => t.toUpperCase()

// The channel view: roots with badges, no reply bodies.
async function expectChannel(terminal: Terminal, f: (t: string) => string = (t) => t) {
  await expect(terminal.getByText(f(ROOT_NEW))).toBeVisible()
  await expect(terminal.getByText(f(ROOT_OLD))).toBeVisible()
  await expect(terminal.getByText('2+ replies')).toBeVisible()
  await expect(terminal.getByText('1+ reply')).toBeVisible()
  const out = pane(terminal)
  for (const t of [...REPLIES_NEW, REPLY_OLD, ORPHAN]) expect(out).not.toContain(f(t))
}

// The newest root's thread: the root and its two replies only.
async function expectThread(terminal: Terminal, f: (t: string) => string = (t) => t) {
  await expect(terminal.getByText(f(REPLIES_NEW[1]!))).toBeVisible()
  const out = pane(terminal)
  for (const t of [ROOT_NEW, ...REPLIES_NEW]) expect(out).toContain(f(t))
  for (const t of [ROOT_OLD, REPLY_OLD, ORPHAN]) expect(out).not.toContain(f(t))
  expect(out).not.toContain('replies')
}

test.describe('single account', () => {
  useConfig()
  test('channel-threads: roots with N+ badges, t opens the thread, h returns', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('# Launch')).toBeVisible()
    // Ada, Design Sync, Ops Channel, then the channel (the team header is not a stop).
    await press(terminal, 'j', 3)
    await press(terminal, 'l')
    await expectChannel(terminal)

    // The cursor starts on the newest root.
    await press(terminal, 't')
    await expectThread(terminal)

    await press(terminal, 'h')
    await expectChannel(terminal)
  })
})

test.describe('two concurrent accounts', () => {
  useConfig({ accounts: ['alpha', 'beta'], activeAccount: 'alpha', concurrentAccounts: true })
  test('channel-threads: each account shows only its own channel and thread text', async ({
    terminal,
  }) => {
    const noAlpha = () => {
      const out = pane(terminal)
      for (const t of [ROOT_NEW, ROOT_OLD, ...REPLIES_NEW]) expect(out).not.toContain(t)
    }
    const noBeta = () => {
      const out = pane(terminal)
      for (const t of [ROOT_NEW, ROOT_OLD, ...REPLIES_NEW]) expect(out).not.toContain(up(t))
    }

    await expect(terminal.getByText('# LAUNCH')).toBeVisible()
    // The cursor starts on alpha's header: Ada, Design Sync, Ops Channel, Launch.
    await press(terminal, 'j', 4)
    await press(terminal, 'l')
    await expectChannel(terminal)
    noBeta()
    await press(terminal, 't')
    await expectThread(terminal)
    noBeta()

    // Back to the list (thread -> channel -> list), down past beta's header
    // to beta's channel: opening it brings beta to the foreground.
    await press(terminal, 'h', 2)
    await press(terminal, 'j', 5)
    await press(terminal, 'l')
    await expectChannel(terminal, up)
    noAlpha()
    await press(terminal, 't')
    await expectThread(terminal, up)
    noAlpha()

    // And back to alpha's channel and thread.
    await press(terminal, 'h', 2)
    await press(terminal, 'k', 5)
    await press(terminal, 'l')
    await expectChannel(terminal)
    noBeta()
    await press(terminal, 't')
    await expectThread(terminal)
    noBeta()
  })
})
