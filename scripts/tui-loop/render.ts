/**
 * Renderer adapter: reads xterm.js buffer cells from a tui-test Terminal via the
 * TypeScript-private `_term` field and decodes color/style to the Cell[][] shape
 * that renderGridSvg() consumes.
 *
 * Access path confirmed in T1.0 sub-gate:
 *   (terminal as any)._term.buffer.active.getLine(row).getCell(col)
 *   → getChars(), getFgColor(), getFgColorMode(), getBgColor(), getBgColorMode(),
 *     isBold(), isInverse()
 *
 * Color decoding (xterm cell color/mode → hex) lives in terminal.ts as
 * decodeXtermColor(); see XTERM_COLOR_MODE there for the mode constants.
 */

import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import type { Cell } from './terminal'
import { decodeXtermColor } from './terminal.js'
import { renderGridSvg } from './svg.js'

// Path to the bundled monospace TTF used for PNG rasterization.
// Resolved relative to this file's directory so it works regardless of cwd.
const MONO_TTF_PATH = join(import.meta.dirname, '../../assets/mono.ttf')

/**
 * Read a Cell[][] from a tui-test Terminal by accessing the underlying xterm.js
 * buffer via the TypeScript-private `_term` field (accessible at JS runtime).
 *
 * @param terminal - a tui-test Terminal instance
 * @param rows     - number of rows to read
 * @param cols     - number of columns to read
 */
export function readCells(terminal: unknown, rows: number, cols: number): Cell[][] {
  const xterm = (terminal as Record<string, unknown>)._term
  if (!xterm) throw new Error('render.ts: _term not found on terminal — tui-test API changed?')

  const activeBuf = (xterm as Record<string, unknown>).buffer as {
    active: {
      getLine(row: number): {
        getCell(
          col: number,
        ): {
          getChars(): string
          getFgColor(): number
          getFgColorMode(): number
          getBgColor(): number
          getBgColorMode(): number
          isBold(): number
          isInverse(): number
        } | null
      } | null
    }
  }

  if (!activeBuf?.active) {
    throw new Error('render.ts: _term.buffer.active not found — tui-test API changed?')
  }

  const grid: Cell[][] = []
  for (let row = 0; row < rows; row++) {
    const line = activeBuf.active.getLine(row)
    const rowCells: Cell[] = []
    for (let col = 0; col < cols; col++) {
      if (!line) {
        rowCells.push({ char: ' ', fg: null, bg: null, bold: false, inverse: false })
        continue
      }
      const cell = line.getCell(col)
      if (!cell) {
        rowCells.push({ char: ' ', fg: null, bg: null, bold: false, inverse: false })
        continue
      }

      const chars = cell.getChars()
      const fgColor = cell.getFgColor()
      const fgMode = cell.getFgColorMode()
      const bgColor = cell.getBgColor()
      const bgMode = cell.getBgColorMode()
      const boldFlag = cell.isBold()
      const inverseFlag = cell.isInverse()

      rowCells.push({
        char: chars === '' ? ' ' : chars,
        fg: decodeXtermColor(fgColor, fgMode),
        bg: decodeXtermColor(bgColor, bgMode),
        bold: boldFlag !== 0,
        inverse: inverseFlag !== 0,
      })
    }
    grid.push(rowCells)
  }

  return grid
}

/**
 * Render a Cell[][] to an SVG string and optionally rasterize to PNG.
 *
 * @param grid  - Cell[][] from readCells()
 * @param label - annotation label for the SVG header
 */
export function renderToSvg(grid: Cell[][], label: string): string {
  return renderGridSvg(grid, label)
}

/**
 * Rasterize an SVG string to a PNG Buffer using @resvg/resvg-js at native 1×
 * scale with the bundled monospace TTF for deterministic font rendering.
 *
 * @param svg - SVG string produced by renderToSvg()
 */
export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontFiles: [MONO_TTF_PATH],
      monospaceFamily: 'Inconsolata',
    },
    fitTo: { mode: 'original' },
    logLevel: 'off',
  })
  return resvg.render().asPng()
}

/**
 * Convenience: read a terminal's current buffer, render to SVG, and rasterize
 * to PNG in one call. Returns both so callers can write both artifacts.
 */
export function captureTerminal(
  terminal: unknown,
  rows: number,
  cols: number,
  label: string,
): { svg: string; png: Buffer } {
  const grid = readCells(terminal, rows, cols)
  const svg = renderToSvg(grid, label)
  const png = svgToPng(svg)
  return { svg, png }
}

// ---------------------------------------------------------------------------
// Standalone sample: when run directly, write a proof-of-concept PNG from a
// synthetic Cell[][] (no PTY needed — just proves resvg round-trip works).
// Usage: bun run scripts/tui-loop/render.ts
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { join: joinPath } = await import('node:path')

  const sampleGrid: Cell[][] = [
    [
      { char: '┌', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      { char: '─', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      { char: '─', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      { char: '┐', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
    ],
    [
      { char: '│', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      { char: 'H', fg: '#ffffff', bg: null, bold: true, inverse: false },
      { char: 'i', fg: '#ffffff', bg: null, bold: false, inverse: false },
      { char: '│', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
    ],
    [
      { char: '└', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      { char: '─', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      { char: '─', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      { char: '┘', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
    ],
  ]

  const outDir = joinPath(process.cwd(), '.tui-test')
  mkdirSync(outDir, { recursive: true })

  const svgOut = renderToSvg(sampleGrid, 'render.ts sample')
  writeFileSync(joinPath(outDir, 'sample.svg'), svgOut, 'utf8')

  const pngOut = svgToPng(svgOut)
  writeFileSync(joinPath(outDir, 'sample.png'), pngOut)

  console.log(
    `Written .tui-test/sample.svg (${svgOut.length} bytes) and .tui-test/sample.png (${pngOut.length} bytes)`,
  )
}
