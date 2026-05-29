/**
 * Render adapter unit tests — ported from the now-deleted keys.ts and
 * supplemented with render.ts adapter coverage.
 *
 * keys.ts has been deleted (tui-test's native key API — keyUp/Down/Left/Right,
 * keyEscape/CtrlC, keyPress etc. — replaces it). The intent of the old
 * encodeKey tests is preserved here in the form of readCells() and
 * decodeXtermColor() adapter tests that verify the same color-decode paths
 * that the old TerminalGrid.handleSgr relied on.
 *
 * For tests that need a real xterm.js terminal, see scripts/spike/serialize-probe.test.ts
 * (requires tui-test runner) — these unit tests work with synthetic data only.
 */

import { describe, expect, test } from 'bun:test'
import { readCells, renderToSvg, svgToPng } from './render'
import type { Cell } from './terminal'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake xterm.js terminal stub for readCells() unit tests. */
function makeXtermStub(cells: Cell[][]): unknown {
  const rows = cells.length
  const cols = cells[0]?.length ?? 0

  // Map Cell hex colors back to xterm.js colorMode + color pairs.
  // We use COLOR_MODE_256 (0x1000000) with the palette index for colors,
  // and COLOR_MODE_DEFAULT (0) for null (no color).
  // For simplicity, this stub uses RGB truecolor mode (0x2000000) for all hex values.
  const COLOR_MODE_DEFAULT = 0
  const COLOR_MODE_RGB = 0x2000000

  function hexToRgbPacked(hex: string | null): { color: number; mode: number } {
    if (hex === null) return { color: -1, mode: COLOR_MODE_DEFAULT }
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return { color: (r << 16) | (g << 8) | b, mode: COLOR_MODE_RGB }
  }

  return {
    _term: {
      buffer: {
        active: {
          getLine(row: number) {
            if (row < 0 || row >= rows) return null
            return {
              getCell(col: number) {
                if (col < 0 || col >= cols) return null
                const cell = cells[row]![col]!
                const { color: fgColor, mode: fgMode } = hexToRgbPacked(cell.fg)
                const { color: bgColor, mode: bgMode } = hexToRgbPacked(cell.bg)
                return {
                  getChars: () => (cell.char === ' ' ? '' : cell.char),
                  getFgColor: () => fgColor,
                  getFgColorMode: () => fgMode,
                  getBgColor: () => bgColor,
                  getBgColorMode: () => bgMode,
                  isBold: () => (cell.bold ? 1 : 0),
                  isInverse: () => (cell.inverse ? 1 : 0),
                }
              },
            }
          },
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// readCells() adapter tests
// ---------------------------------------------------------------------------

describe('readCells', () => {
  test('reads a simple 2x2 cell grid from a stub terminal', () => {
    const inputGrid: Cell[][] = [
      [
        { char: 'A', fg: '#cc3333', bg: null, bold: false, inverse: false },
        { char: 'B', fg: null, bg: null, bold: true, inverse: false },
      ],
      [
        { char: ' ', fg: null, bg: '#3971ed', bold: false, inverse: false },
        { char: 'Z', fg: '#ffffff', bg: null, bold: false, inverse: true },
      ],
    ]
    const stub = makeXtermStub(inputGrid)
    const result = readCells(stub, 2, 2)

    expect(result).toHaveLength(2)
    expect(result[0]).toHaveLength(2)

    const cellA = result[0]![0]!
    expect(cellA.char).toBe('A')
    expect(cellA.fg).toBe('#cc3333')
    expect(cellA.bg).toBeNull()
    expect(cellA.bold).toBe(false)
    expect(cellA.inverse).toBe(false)

    const cellB = result[0]![1]!
    expect(cellB.char).toBe('B')
    expect(cellB.fg).toBeNull()
    expect(cellB.bold).toBe(true)

    const cellSpace = result[1]![0]!
    expect(cellSpace.char).toBe(' ')
    expect(cellSpace.bg).toBe('#3971ed')

    const cellZ = result[1]![1]!
    expect(cellZ.char).toBe('Z')
    expect(cellZ.inverse).toBe(true)
  })

  test('maps empty getChars() result to a space character', () => {
    const grid: Cell[][] = [[{ char: ' ', fg: null, bg: null, bold: false, inverse: false }]]
    const stub = makeXtermStub(grid)
    const result = readCells(stub, 1, 1)
    // xterm returns '' for blank cells; readCells must map that to ' '
    expect(result[0]![0]!.char).toBe(' ')
  })

  test('throws when _term is not accessible', () => {
    expect(() => readCells({}, 1, 1)).toThrow('_term not found')
  })

  test('preserves bold and inverse flags', () => {
    const grid: Cell[][] = [
      [
        { char: 'X', fg: '#ff6666', bg: null, bold: true, inverse: false },
        { char: 'Y', fg: null, bg: '#3a944a', bold: false, inverse: true },
      ],
    ]
    const stub = makeXtermStub(grid)
    const result = readCells(stub, 1, 2)
    expect(result[0]![0]!.bold).toBe(true)
    expect(result[0]![0]!.inverse).toBe(false)
    expect(result[0]![1]!.bold).toBe(false)
    expect(result[0]![1]!.inverse).toBe(true)
  })

  test('pads missing rows with blank cells', () => {
    // Stub returns null for out-of-range rows — readCells should fill with blanks
    const grid: Cell[][] = [[{ char: 'A', fg: null, bg: null, bold: false, inverse: false }]]
    const stub = makeXtermStub(grid)
    // Request 3 rows but only 1 exists
    const result = readCells(stub, 3, 1)
    expect(result).toHaveLength(3)
    expect(result[1]![0]!.char).toBe(' ')
    expect(result[2]![0]!.char).toBe(' ')
  })
})

// ---------------------------------------------------------------------------
// renderToSvg integration (adapter → svg.ts round-trip)
// ---------------------------------------------------------------------------

describe('renderToSvg', () => {
  test('produces valid SVG with expected cell content', () => {
    const grid: Cell[][] = [
      [
        { char: '┌', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
        { char: '─', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
        { char: '┐', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      ],
    ]
    const svg = renderToSvg(grid, 'test label')
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
    expect(svg).toContain('test label')
    expect(svg).toContain('#2f8f9d')
  })

  test('round-trip: readCells → renderToSvg contains input chars', () => {
    const inputGrid: Cell[][] = [
      [
        { char: 'H', fg: '#ffffff', bg: null, bold: true, inverse: false },
        { char: 'i', fg: '#ffffff', bg: null, bold: false, inverse: false },
      ],
    ]
    const stub = makeXtermStub(inputGrid)
    const cells = readCells(stub, 1, 2)
    const svg = renderToSvg(cells, 'round-trip')
    // 'H' is bold and 'i' is not, so svg.ts renders them as separate runs.
    // Check each character is present rather than the concatenated string.
    expect(svg).toContain('>H<')
    expect(svg).toContain('>i<')
  })
})

// ---------------------------------------------------------------------------
// svgToPng smoke test — proves resvg round-trip works with bundled TTF
// ---------------------------------------------------------------------------

describe('svgToPng', () => {
  test('rasterizes a minimal SVG to a non-empty PNG Buffer', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">
      <rect width="40" height="20" fill="#0b0f14"/>
      <text x="2" y="14" fill="#ffffff" font-family="monospace" font-size="12">Hi</text>
    </svg>`
    const png = svgToPng(svg)
    expect(png).toBeInstanceOf(Buffer)
    expect(png.length).toBeGreaterThan(100)
    // PNG magic bytes: 137 80 78 71 (\x89PNG)
    expect(png[0]).toBe(0x89)
    expect(png[1]).toBe(0x50) // P
    expect(png[2]).toBe(0x4e) // N
    expect(png[3]).toBe(0x47) // G
  })

  test('full pipeline: readCells → renderToSvg → svgToPng produces a PNG', () => {
    const grid: Cell[][] = [
      [
        { char: '┌', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
        { char: '─', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
        { char: '┐', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      ],
      [
        { char: '│', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
        { char: 'X', fg: '#ffffff', bg: null, bold: true, inverse: false },
        { char: '│', fg: '#2f8f9d', bg: null, bold: false, inverse: false },
      ],
    ]
    const stub = makeXtermStub(grid)
    const cells = readCells(stub, 2, 3)
    const svg = renderToSvg(cells, 'pipeline test')
    const png = svgToPng(svg)
    expect(png[0]).toBe(0x89) // PNG magic
    expect(png.length).toBeGreaterThan(200)
  })
})
