/**
 * Flow: chat-shell
 *
 * Verifies the initial chat-list shell and keyboard navigation in the
 * seeded real Ink app (TEAMINAL_SEED=fixtures). Converted from the
 * declarative tui.config.mjs flow in T2.2.
 *
 * Verb mapping from legacy config steps:
 *   waitForText / assertText → expect(terminal.getByText(...)).toBeVisible()
 *   key                      → terminal.keyPress(key) / named key helpers
 *   shot                     → captureTerminal() → SVG + PNG  AND  terminal.toMatchSnapshot()
 *
 * RUNNER: node node_modules/@microsoft/tui-test/index.js (not bun test).
 * The seeded program is declared in tui-test.config.ts project "seeded-real-app";
 * test.use() here overrides only what differs from that default.
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
const SHOTS_DIR = path.resolve(process.cwd(), '.tui-loop/shots/chat-shell')

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
// Test: initial shell renders "Ada Byron" at startup
// ---------------------------------------------------------------------------
test('initial-shell: Ada Byron visible on startup', async ({ terminal }) => {
  // Wait for the seeded Ink app to paint the chat list.
  await expect(terminal.getByText('Ada Byron')).toBeVisible()

  // Text-snapshot gate — updates via `--update` flag on the tui-test runner.
  await expect(terminal).toMatchSnapshot({ includeColors: true })

  // Write PNG + SVG for agent-facing visual inspection (not a pass/fail gate).
  await writeShot(terminal, 'initial-shell', 'Initial chat shell')
})

// ---------------------------------------------------------------------------
// Test: pressing 'j' moves selection to Design Sync
// ---------------------------------------------------------------------------
test('chat-list-selection: j key moves selection to Design Sync', async ({ terminal }) => {
  // Confirm startup first.
  await expect(terminal.getByText('Ada Byron')).toBeVisible()

  // Press 'j' to move selection down — maps to legacy `key: 'j'` step.
  terminal.write('j')

  // Design Sync should now be highlighted / visible.
  await expect(terminal.getByText('Design Sync')).toBeVisible()

  // Text-snapshot gate.
  await expect(terminal).toMatchSnapshot({ includeColors: true })

  // Agent-facing artifacts.
  await writeShot(terminal, 'chat-list-selection', 'Chat list selection moved down')
})
