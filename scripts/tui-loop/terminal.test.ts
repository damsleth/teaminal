/**
 * Tests for the color-decode helpers in terminal.ts.
 *
 * The ANSI escape-sequence state-machine (TerminalGrid) that used to live here
 * has been removed — xterm.js (via tui-test) owns parsing now. These tests
 * verify that color256Decode / rgbHexDecode / ansiIndexToHex decode correctly,
 * which is the logic render.ts relies on when mapping xterm.js cell color values
 * to the hex strings that renderGridSvg() expects.
 */

import { describe, expect, test } from 'bun:test'
import { color256Decode, rgbHexDecode, ansiIndexToHex, ANSI_COLORS } from './terminal'

describe('rgbHexDecode', () => {
  test('formats r/g/b to lowercase hex with leading zeros', () => {
    expect(rgbHexDecode(0, 0, 0)).toBe('#000000')
    expect(rgbHexDecode(255, 255, 255)).toBe('#ffffff')
    expect(rgbHexDecode(10, 20, 30)).toBe('#0a141e')
  })

  test('clamps values to 0-255', () => {
    expect(rgbHexDecode(-1, 300, 128)).toBe('#00ff80')
  })
})

describe('color256Decode', () => {
  test('maps the 16 base colors consistently with ANSI_256_BASE', () => {
    // Index 0 = black, index 1 = red, index 7 = light-grey, index 15 = white
    expect(color256Decode(0)).toBe('#111111')
    expect(color256Decode(1)).toBe('#cc3333')
    expect(color256Decode(7)).toBe('#d6d6d6')
    expect(color256Decode(15)).toBe('#ffffff')
  })

  test('decodes a 6x6x6 color cube index correctly', () => {
    // Index 196 = top-right of red cube: offset=180, r=5 → 255, g=0 → 0, b=0 → 0
    expect(color256Decode(196)).toBe('#ff0000')
    // Index 46 = pure green: offset=30, r=0→0, g=5→255, b=0→0
    expect(color256Decode(46)).toBe('#00ff00')
    // Index 21 = pure blue: offset=5, r=0→0, g=0→0, b=5→255
    expect(color256Decode(21)).toBe('#0000ff')
  })

  test('decodes the grayscale ramp', () => {
    // Index 232 = darkest gray: 8 + 0*10 = 8
    expect(color256Decode(232)).toBe('#080808')
    // Index 236 = 8 + 4*10 = 48 = 0x30
    expect(color256Decode(236)).toBe('#303030')
    // Index 255 = lightest gray: 8 + 23*10 = 238
    expect(color256Decode(255)).toBe('#eeeeee')
  })

  test('returns null for out-of-range values', () => {
    expect(color256Decode(-1)).toBeNull()
    expect(color256Decode(256)).toBeNull()
    expect(color256Decode(1.5)).toBeNull()
  })
})

describe('ansiIndexToHex', () => {
  test('maps 0-based ANSI index to hex', () => {
    // 0=black, 1=red, 6=cyan, 15=white
    expect(ansiIndexToHex(0)).toBe('#111111')
    expect(ansiIndexToHex(1)).toBe('#cc3333')
    expect(ansiIndexToHex(6)).toBe('#2f8f9d')
    expect(ansiIndexToHex(15)).toBe('#ffffff')
  })

  test('returns null for out-of-range index', () => {
    expect(ansiIndexToHex(16)).toBeNull()
    expect(ansiIndexToHex(-1)).toBeNull()
  })
})

describe('ANSI_COLORS', () => {
  test('covers the 8 standard and 8 bright foreground codes', () => {
    expect(Object.keys(ANSI_COLORS)).toHaveLength(16)
    // Standard codes 30-37
    for (let code = 30; code <= 37; code++) {
      expect(ANSI_COLORS[code]).toMatch(/^#[0-9a-f]{6}$/)
    }
    // Bright codes 90-97
    for (let code = 90; code <= 97; code++) {
      expect(ANSI_COLORS[code]).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  test('ANSI code 36 (cyan) matches the brand teal used in the TUI border', () => {
    expect(ANSI_COLORS[36]).toBe('#2f8f9d')
  })
})
