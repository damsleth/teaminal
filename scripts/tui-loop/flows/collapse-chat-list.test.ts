/**
 * Flow: collapse-chat-list
 *
 * Ctrl+B hides the chat list: list and conversation share one pane, l/Enter
 * shows the chat, h shows the list again.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import { test, expect } from '@microsoft/tui-test'
import { TUI_ENV } from '../isolatedConfig.js'

test.use({
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { ...TUI_ENV },
  rows: 30,
  columns: 100,
})

const screen = (terminal: { getViewableBuffer(): string[][] }) =>
  terminal
    .getViewableBuffer()
    .map((row) => row.join(''))
    .join('\n')

// Ctrl+B and the next key sent back to back can reach the app in one read
// on a loaded CI runner, so give the toggle a moment to land first.
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms))

test('collapse-chat-list: Ctrl+B toggles a single list/chat pane', async ({ terminal }) => {
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  // Design Sync is a list row only (never in Ada's conversation).
  await expect(terminal.getByText('Design Sync')).toBeVisible()

  terminal.write('\x02') // Ctrl+B
  await pause()
  terminal.write('l') // open the first chat
  await expect(terminal.getByText('Design Sync')).not.toBeVisible()

  terminal.write('h') // back to the list, which replaces the chat
  await expect(terminal.getByText('Design Sync')).toBeVisible()

  terminal.write('\x02') // restore side-by-side
  await pause()
  terminal.write('l')
  await expect(terminal.getByText('Design Sync')).toBeVisible()
  expect(screen(terminal)).toContain('Ada Byron')
})
