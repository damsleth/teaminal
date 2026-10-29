/**
 * Flow: context menu ('.')
 *
 *   On the chat list, '.' opens a menu for the selected row (Open, Mark as
 *   read/unread, Delete chat…) beside the row, not centered; Esc closes it.
 *   In a conversation, '.' on the focused message offers React….
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

const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))
const screen = (terminal: { getViewableBuffer(): string[][] }) =>
  terminal.getViewableBuffer().map((row) => row.join(''))

test('context-menu: chat row and message', async ({ terminal }) => {
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  await pause()
  terminal.write('.')
  await expect(terminal.getByText('Delete chat…')).toBeVisible()
  await expect(terminal.getByText('Mark as')).toBeVisible()
  // Beside the selected row: the menu's first entry is on the row's line,
  // right of where the name starts.
  const rows = screen(terminal)
  const ada = rows.findIndex((r) => r.includes('Ada Byron'))
  const open = rows.findIndex((r) => r.includes('> Open'))
  if (open === -1 || Math.abs(open - ada) > 2)
    throw new Error(`menu not beside the row: Ada on ${ada}, Open on ${open}`)
  if (rows[open]!.indexOf('> Open') <= rows[ada]!.indexOf('Ada Byron'))
    throw new Error('menu not to the right of the row')
  terminal.keyEscape()
  await expect(terminal.getByText('Delete chat…')).not.toBeVisible()

  // Into the conversation; the newest message is focused.
  terminal.submit()
  await expect(terminal.getByText('The launch notes are ready for review.')).toBeVisible()
  await pause()
  terminal.write('.')
  await expect(terminal.getByText('React…')).toBeVisible()
  terminal.keyEscape()
  await expect(terminal.getByText('React…')).not.toBeVisible()
})
