/**
 * T0.2 — throwaway spike: probe @microsoft/tui-test serialize() and getViewableBuffer()
 * T1.0 — sub-gate: probe whether terminal.buffer?.active?.getLine/getCell is reachable
 *
 * Launches the real seeded app (TEAMINAL_SEED=fixtures) via a PTY and dumps:
 *   - terminal.serialize()  → { view, shifts }
 *   - terminal.getViewableBuffer()  → sample of cells from first five rows
 *   - T1.0: terminal.buffer?.active?.getLine(0)?.getCell(0)  → xterm.js cell API
 *   - T1.0: (terminal as any)._term?.buffer?.active?.getLine(0)?.getCell(0)  → via private field
 *
 * Gate output (T0.3): see test "gate: serialize fidelity report" at bottom.
 * Gate output (T1.0): see test "T1.0 sub-gate: xterm.js buffer cell API reachability" at bottom.
 *
 * RUNNER: bunx @microsoft/tui-test (not bun test — this file is excluded
 * from bun's test runner via bunfig.toml pathIgnorePatterns).
 */

import { test, expect } from '@microsoft/tui-test'
import path from 'node:path'
import fs from 'node:fs'
import { TUI_ENV } from '../tui-loop/isolatedConfig.js'

// Point at the real seeded app. TEAMINAL_SEED=fixtures enables offline mode
// (no Graph / owa-piggy auth) so the app boots deterministically inside a PTY.
const APP = path.resolve(process.cwd(), 'bin/teaminal.tsx')

test.use({
  program: { file: 'bun', args: ['run', APP] },
  env: { ...TUI_ENV },
  rows: 30,
  columns: 100,
})

const PROBE_OUT = path.resolve(process.cwd(), '.tui-test/spike-probe-output.txt')

test('dump serialize() view and shifts', async ({ terminal }) => {
  // The fixture renders immediately on startup. Give node-pty + xterm 2s to
  // process the PTY output before we snapshot the buffer.
  await new Promise((r) => setTimeout(r, 2000))

  const { view, shifts } = terminal.serialize()
  const buf = terminal.getViewableBuffer()

  const lines: string[] = []
  lines.push('\n=== serialize().view ===')
  lines.push(view)
  lines.push('\n=== serialize().shifts (first 20 entries) ===')
  let count = 0
  for (const [key, shift] of shifts) {
    if (count++ >= 20) break
    lines.push(`  ${key}: ${JSON.stringify(shift)}`)
  }
  lines.push(`  (total shift entries: ${shifts.size})`)

  // getViewableBuffer() returns a 2-D array of cell strings.
  lines.push('\n=== getViewableBuffer() — first 5 rows (raw cells) ===')
  for (let r = 0; r < Math.min(5, buf.length); r++) {
    const row = buf[r] ?? []
    lines.push(`  row[${r}]: ${JSON.stringify(row.slice(0, 40))}`)
  }
  lines.push(`  (total rows: ${buf.length}, cols per row: ${(buf[0] ?? []).length})`)

  // Check for seed data text in the rendered buffer.
  const block = buf.map((row) => row.join('')).join('')
  const found = block.includes('Ada Byron')
  lines.push(`\n  "Ada Byron" found in buffer: ${found}`)

  const output = lines.join('\n')
  process.stdout.write(output + '\n')
  fs.appendFileSync(PROBE_OUT, output + '\n')

  // Minimal assertion: view must be non-empty (program rendered something).
  expect(view.length).toBeGreaterThan(0)
})

test('gate: serialize fidelity report', async ({ terminal }) => {
  // Give node-pty + xterm 2s to process the PTY output.
  await new Promise((r) => setTimeout(r, 2000))

  const { view, shifts } = terminal.serialize()
  const buf = terminal.getViewableBuffer()

  // Count non-trivial (colored) shift entries — proxy for fg/bg richness.
  let hasFg = 0
  let hasBg = 0
  let hasBold = 0
  for (const shift of shifts.values()) {
    if (shift.fgColor !== undefined) hasFg++
    if (shift.bgColor !== undefined) hasBg++
    if (shift.bold !== undefined) hasBold++
  }

  const block = buf.map((row) => row.join('')).join('')
  const report = {
    // Can we distinguish characters?
    viewLines: view.split('\n').length,
    viewNonEmpty: view.split('\n').filter((l) => l.trim().length > 0).length,
    fixtureTextFound: block.includes('Ada Byron'),
    // Color metadata richness
    totalShifts: shifts.size,
    shiftsWithFg: hasFg,
    shiftsWithBg: hasBg,
    shiftsWithBold: hasBold,
    // Cell granularity
    bufRows: buf.length,
    bufCols: (buf[0] ?? []).length,
    // T0.3 gate decision
    sufficient:
      hasFg > 0 &&
      buf.length === 30 &&
      (buf[0] ?? []).length === 100 &&
      block.includes('Ada Byron'),
  }

  const gateOutput =
    '\n=== T0.3 Gate: fidelity report ===\n' + JSON.stringify(report, null, 2) + '\n'
  process.stdout.write(gateOutput)
  fs.appendFileSync(PROBE_OUT, gateOutput)

  // The test passes regardless — this is a probe, not a gate assertion.
  // The orchestrator agent reads the stdout to make the go/no-go decision.
  expect(report.viewLines).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// T1.0 sub-gate: confirm whether xterm.js buffer cell API is reachable
//
// The plan calls for reading cells via:
//   terminal.buffer?.active?.getLine(row)?.getCell(col)
//   → getChars(), getFgColor(), getFgColorMode(), getBgColor(), getBgColorMode(),
//     isBold(), isInverse()
//
// tui-test's Terminal class does NOT expose `.buffer` on its public API
// (confirmed by inspecting term.d.ts and term.js). The xterm.js instance is
// stored in the private field `_term`.
//
// In JavaScript, TypeScript "private" fields (declared with the `private`
// keyword) are NOT truly private at runtime — they're just hidden from the
// type-checker. They are accessible via bracket notation: (obj as any)._term
//
// This probe tries both access paths and reports which one yields real cell data.
// ---------------------------------------------------------------------------
test('T1.0 sub-gate: xterm.js buffer cell API reachability', async ({ terminal }) => {
  await new Promise((r) => setTimeout(r, 2000))

  const lines: string[] = []
  lines.push('\n=== T1.0 Sub-gate: xterm.js buffer cell API ===')

  // Path 1: public terminal.buffer — NOT in type definition, likely undefined
  const publicBuffer = (terminal as any).buffer
  lines.push(
    `  terminal.buffer: ${publicBuffer === undefined ? 'undefined (not exposed)' : typeof publicBuffer}`,
  )

  // Path 2: private _term field — TypeScript private but accessible at JS runtime
  const xtermInstance = (terminal as any)._term
  lines.push(
    `  (terminal as any)._term: ${xtermInstance === undefined ? 'undefined' : typeof xtermInstance}`,
  )
  lines.push(
    `  _term.buffer: ${xtermInstance?.buffer === undefined ? 'undefined' : typeof xtermInstance?.buffer}`,
  )
  lines.push(
    `  _term.buffer.active: ${xtermInstance?.buffer?.active === undefined ? 'undefined' : typeof xtermInstance?.buffer?.active}`,
  )

  // Try getLine
  const activeBuf = xtermInstance?.buffer?.active
  const line0 = activeBuf?.getLine?.(0)
  lines.push(`  getLine(0): ${line0 === undefined ? 'undefined' : typeof line0}`)
  lines.push(
    `  getLine(0) keys: ${line0 ? JSON.stringify(Object.keys(Object.getPrototypeOf(line0) ?? {})) : 'n/a'}`,
  )

  // Try getCell on row 0
  const cell0 = line0?.getCell?.(0)
  lines.push(`  getCell(0,0): ${cell0 === undefined ? 'undefined' : typeof cell0}`)

  // If we got a cell, probe all the methods the plan needs
  const cellMethods: Record<string, unknown> = {}
  if (cell0 !== undefined && cell0 !== null) {
    try {
      cellMethods.getChars = cell0.getChars?.()
    } catch (e) {
      cellMethods.getChars = `ERROR: ${e}`
    }
    try {
      cellMethods.getFgColor = cell0.getFgColor?.()
    } catch (e) {
      cellMethods.getFgColor = `ERROR: ${e}`
    }
    try {
      cellMethods.getFgColorMode = cell0.getFgColorMode?.()
    } catch (e) {
      cellMethods.getFgColorMode = `ERROR: ${e}`
    }
    try {
      cellMethods.getBgColor = cell0.getBgColor?.()
    } catch (e) {
      cellMethods.getBgColor = `ERROR: ${e}`
    }
    try {
      cellMethods.getBgColorMode = cell0.getBgColorMode?.()
    } catch (e) {
      cellMethods.getBgColorMode = `ERROR: ${e}`
    }
    try {
      cellMethods.isBold = cell0.isBold?.()
    } catch (e) {
      cellMethods.isBold = `ERROR: ${e}`
    }
    try {
      cellMethods.isInverse = cell0.isInverse?.()
    } catch (e) {
      cellMethods.isInverse = `ERROR: ${e}`
    }
    lines.push(`  cell(0,0) method results: ${JSON.stringify(cellMethods, null, 2)}`)
  } else {
    lines.push('  cell(0,0): NOT reachable — cannot probe methods')
  }

  // Scan a few rows from the buffer to find a colored cell (row 1 has a colored border)
  let coloredCellFound = false
  let coloredCellSample: Record<string, unknown> = {}
  if (activeBuf) {
    for (let row = 0; row < Math.min(5, activeBuf.length ?? 0); row++) {
      const line = activeBuf.getLine?.(row)
      for (let col = 0; col < 100; col++) {
        const cell = line?.getCell?.(col)
        if (!cell) continue
        const fg = cell.getFgColor?.()
        const fgMode = cell.getFgColorMode?.()
        const bg = cell.getBgColor?.()
        const bgMode = cell.getBgColorMode?.()
        const bold = cell.isBold?.()
        const inverse = cell.isInverse?.()
        if (fgMode !== undefined && fgMode > 0) {
          coloredCellFound = true
          coloredCellSample = {
            row,
            col,
            char: cell.getChars?.() || ' ',
            fg,
            fgMode,
            bg,
            bgMode,
            bold,
            inverse,
          }
          break
        }
      }
      if (coloredCellFound) break
    }
  }
  lines.push(`  colored cell found in first 5 rows: ${coloredCellFound}`)
  if (coloredCellFound) {
    lines.push(`  sample colored cell: ${JSON.stringify(coloredCellSample)}`)
  }

  // T1.0 gate decision
  const allMethodsWork =
    cell0 !== undefined &&
    cell0 !== null &&
    typeof cellMethods.getChars !== 'undefined' &&
    !String(cellMethods.getChars).startsWith('ERROR') &&
    typeof cellMethods.getFgColor !== 'undefined' &&
    !String(cellMethods.getFgColor).startsWith('ERROR') &&
    typeof cellMethods.getFgColorMode !== 'undefined' &&
    !String(cellMethods.getFgColorMode).startsWith('ERROR') &&
    typeof cellMethods.getBgColor !== 'undefined' &&
    !String(cellMethods.getBgColor).startsWith('ERROR') &&
    typeof cellMethods.getBgColorMode !== 'undefined' &&
    !String(cellMethods.getBgColorMode).startsWith('ERROR') &&
    typeof cellMethods.isBold !== 'undefined' &&
    !String(cellMethods.isBold).startsWith('ERROR') &&
    typeof cellMethods.isInverse !== 'undefined' &&
    !String(cellMethods.isInverse).startsWith('ERROR')

  const gateReport = {
    publicBufferExposed: publicBuffer !== undefined,
    privateTermAccessible: xtermInstance !== undefined,
    bufferActiveReachable: activeBuf !== undefined,
    getLineWorks: line0 !== undefined,
    getCellWorks: cell0 !== undefined,
    allCellMethodsWork: allMethodsWork,
    coloredCellFound,
    coloredCellSample: coloredCellFound ? coloredCellSample : null,
    // T1.0 gate: reachable=true if we can access cell data via _term private field
    reachable: allMethodsWork && coloredCellFound,
    accessPath:
      xtermInstance !== undefined
        ? '(terminal as any)._term.buffer.active.getLine(row).getCell(col)'
        : 'NONE — _term not accessible',
    fallback:
      publicBuffer === undefined && xtermInstance === undefined
        ? 'getBuffer() returns string[][] (chars only); patch tui-test to expose buffer or use serialize().shifts reconstruction'
        : undefined,
  }

  const gateOutput =
    '\n=== T1.0 Gate: xterm.js buffer cell API reachability ===\n' +
    JSON.stringify(gateReport, null, 2) +
    '\n'
  lines.push(gateOutput)

  const output = lines.join('\n')
  process.stdout.write(output + '\n')
  fs.mkdirSync(path.dirname(PROBE_OUT), { recursive: true })
  fs.appendFileSync(PROBE_OUT, output + '\n')

  // Probe always passes — orchestrator reads stdout for gate decision.
  expect(true).toBe(true)
})
