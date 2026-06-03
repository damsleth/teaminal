/**
 * Flow: menu-and-composer
 *
 * Verifies two real interactions in the seeded app (asserted against
 * observed behavior, not the legacy fixture's assumptions):
 *   1. Ctrl-A opens the Activity panel overlay.
 *   2. Opening a chat (Enter) then Tab moves focus into the composer.
 *
 * Key mapping:
 *   Ctrl-A  → terminal.keyPress("a", { ctrl: true })   (opens Activity)
 *   Escape  → terminal.keyEscape()                      (closes overlay)
 *   Enter   → terminal.submit()                          (opens focused chat)
 *   Tab     → terminal.write("\t")                       (focus → composer)
 *   shot    → captureTerminal() → SVG + PNG  AND  terminal.toMatchSnapshot()
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 */

import path from 'node:path'
import fs from 'node:fs'
import { test, expect } from '@microsoft/tui-test'
import { captureTerminal } from '../render.js'
import { TUI_ENV } from '../isolatedConfig.js'

// ---------------------------------------------------------------------------
// Viewport / program shared across this flow
// ---------------------------------------------------------------------------
const ROWS = 30
const COLS = 100

test.use({
  program: { file: 'bun', args: ['run', 'bin/teaminal.tsx'] },
  env: { ...TUI_ENV },
  rows: ROWS,
  columns: COLS,
})

// Output directory for PNG / SVG artifacts (agent-facing, not a test gate).
const SHOTS_DIR = path.resolve(process.cwd(), '.tui-loop/shots/menu-and-composer')

function ensureShotsDir(): void {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
}

/**
 * Write SVG + PNG for a named shot. These are agent-facing artifacts only —
 * pass/fail is gated on text snapshots (toMatchSnapshot()), not on images.
 */
async function writeShot(
  terminal: Parameters<typeof captureTerminal>[0],
  name: string,
  label: string,
): Promise<void> {
  ensureShotsDir()
  try {
    const { svg, png } = captureTerminal(terminal, ROWS, COLS, label)
    fs.writeFileSync(path.join(SHOTS_DIR, `${name}.svg`), svg, 'utf8')
    fs.writeFileSync(path.join(SHOTS_DIR, `${name}.png`), png)
  } catch {
    // Visual render is best-effort — don't fail the test if SVG/PNG writing fails.
  }
}

// ---------------------------------------------------------------------------
// Test: Ctrl-A opens the Activity panel; Escape closes it
// ---------------------------------------------------------------------------
test('activity-panel: Ctrl-A opens the Activity overlay', async ({ terminal }) => {
  // Wait for the seeded Ink app to paint — Ada Byron is in the first chat.
  await expect(terminal.getByText('Ada Byron')).toBeVisible()

  // Ctrl-A opens the Activity overlay (App.tsx → openActivity).
  terminal.keyPress('a', { ctrl: true })

  // The overlay shows the Activity heading and its distinctive help line.
  await expect(terminal.getByText('Activity')).toBeVisible()
  await expect(terminal.getByText('mark all read')).toBeVisible()

  // Text-snapshot gate for the open overlay.
  await expect(terminal).toMatchSnapshot({ includeColors: true })

  // Agent-facing artifacts.
  await writeShot(terminal, 'activity-open', 'Activity overlay open')

  // Escape closes it and returns to the chat list.
  terminal.keyEscape()
  await expect(terminal.getByText('mark all read')).not.toBeVisible()
  await expect(terminal.getByText('Ada Byron')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Test: opening a chat then Tab moves focus into the composer
// ---------------------------------------------------------------------------
test('composer-active: Enter opens a chat and Tab focuses the composer', async ({ terminal }) => {
  // Confirm startup; Ada Byron is the focused row.
  await expect(terminal.getByText('Ada Byron')).toBeVisible()

  // Enter opens the focused chat (listKeys: key.return → open). The seeded
  // conversation body proves navigation actually landed in the chat.
  terminal.submit()
  await expect(terminal.getByText('The launch notes are ready for review.')).toBeVisible()

  // Tab moves focus from the list into the composer (App.tsx tab handler).
  terminal.write('\t')

  // The composer-active footer is unique to this state — a robust signal that
  // focus reached the composer. (A bare ">" is ambiguous: the chat-list
  // selection and the composer prompt both render one.)
  await expect(terminal.getByText('Enter send')).toBeVisible()

  // Text-snapshot gate for the composer-active state.
  await expect(terminal).toMatchSnapshot({ includeColors: true })

  // Agent-facing artifacts.
  await writeShot(terminal, 'composer-active', 'Composer active')
})
