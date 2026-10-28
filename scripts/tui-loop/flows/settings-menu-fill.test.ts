/**
 * Flow: settings-menu-fill
 *
 * The Settings submenu grows to the window: in a tall terminal the whole
 * list fits (first and last item on screen, no ⋯ scroll markers), and a
 * long row isn't cut at the logo width.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import { test, expect } from '@microsoft/tui-test'
import { TUI_ENV } from '../isolatedConfig.js'

test.use({
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { ...TUI_ENV },
  rows: 70,
  columns: 140,
})

const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms))

const screen = (terminal: { getViewableBuffer(): string[][] }) =>
  terminal
    .getViewableBuffer()
    .map((row) => row.join(''))
    .join('\n')

test('settings-menu-fill: the Settings list fills a tall window without scrolling', async ({
  terminal,
}) => {
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
  terminal.keyEscape()
  await expect(terminal.getByText('Settings')).toBeVisible()
  await pause()
  terminal.write('j')
  await pause()
  terminal.write('j')
  await pause()
  terminal.submit()
  await expect(terminal.getByText('Empty cache (this profile)')).toBeVisible()
  const out = screen(terminal)
  expect(out).toContain('Theme editor')
  expect(out).toContain('(off = link/image actions only)')
  expect(out).not.toContain('⋯')
})
