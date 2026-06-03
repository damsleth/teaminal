/**
 * Flow: statusbar-top
 *
 * Locks in the statusBarPosition='top' layout fix: the HeaderBar renders on a
 * single truncated row so its bordered box never balloons or jumps as the
 * (dynamic) header segments change, even when the terminal is too narrow to
 * fit the whole line. Regression guard for the "header border too narrow /
 * text overflows" bug — before the fix the segment <Text> nodes wrapped
 * independently, splitting words ("teami / al") across several rows.
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'

function topConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaminal-tui-sbtop-'))
  fs.mkdirSync(path.join(dir, 'teaminal'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'teaminal', 'config.json'),
    JSON.stringify({ theme: 'dark', statusBarPosition: 'top' }, null, 2),
  )
  return dir
}

test.describe('statusbar-top wide', () => {
  test.use({
    program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
    env: { TEAMINAL_SEED: 'fixtures', XDG_CONFIG_HOME: topConfigDir() },
    rows: 30,
    columns: 100,
  })

  test('status bar renders at the top, header is a single bordered row', async ({ terminal }) => {
    await expect(terminal.getByText('Ada Byron')).toBeVisible()
    // The status-bar key hints sit above the header when position='top'.
    await expect(terminal.getByText('j/k move')).toBeVisible()
    await expect(terminal.getByText('teaminal')).toBeVisible()
    await expect(terminal).toMatchSnapshot({ includeColors: true })
  })
})

test.describe('statusbar-top narrow', () => {
  test.use({
    program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
    env: { TEAMINAL_SEED: 'fixtures', XDG_CONFIG_HOME: topConfigDir() },
    rows: 30,
    columns: 50,
  })

  test('narrow header truncates to one row instead of wrapping/jumping', async ({ terminal }) => {
    // 'teaminal' must remain on one contiguous line — pre-fix it wrapped to
    // "teami" / "al" across rows and this lookup would fail.
    await expect(terminal.getByText('teaminal')).toBeVisible()
    await new Promise((r) => setTimeout(r, 400))
    await expect(terminal).toMatchSnapshot({ includeColors: true })
  })
})
