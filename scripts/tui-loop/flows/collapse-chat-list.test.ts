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

test('collapse-chat-list: Ctrl+B toggles a single list/chat pane', async ({ terminal }) => {
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  // Design Sync is a list row only (never in Ada's conversation).
  await expect(terminal.getByText('Design Sync')).toBeVisible()

  terminal.write('\x02') // Ctrl+B
  terminal.write('l') // open the first chat
  await expect(terminal.getByText('Design Sync')).not.toBeVisible()

  terminal.write('h') // back to the list, which replaces the chat
  await expect(terminal.getByText('Design Sync')).toBeVisible()

  terminal.write('\x02') // restore side-by-side
  terminal.write('l')
  await expect(terminal.getByText('Design Sync')).toBeVisible()
  expect(screen(terminal)).toContain('Ada Byron')
})
