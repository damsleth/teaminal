/**
 * Color-decode helpers shared by render.ts (xterm.js buffer adapter) and svg.ts.
 *
 * The ANSI escape-sequence state-machine parser (TerminalGrid) that used to live
 * here has been removed — xterm.js (via tui-test) owns parsing now. Only the
 * color look-up tables and decode functions are kept.
 */

export type CellStyle = {
  fg: string | null
  bg: string | null
  bold: boolean
  inverse: boolean
}

export type Cell = CellStyle & {
  char: string
}

/** ANSI SGR 30-37 / 90-97 foreground color map (and background via -10 offset). */
export const ANSI_COLORS: Record<number, string> = {
  30: '#111111',
  31: '#cc3333',
  32: '#3a944a',
  33: '#b58b00',
  34: '#3971ed',
  35: '#a36ac7',
  36: '#2f8f9d',
  37: '#d6d6d6',
  90: '#777777',
  91: '#ff6666',
  92: '#66c56f',
  93: '#e0b84b',
  94: '#6b9cff',
  95: '#c792ea',
  96: '#55c1d1',
  97: '#ffffff',
}

// The 16 base colors of the 256-color palette, aligned with ANSI_COLORS above.
const ANSI_256_BASE = [
  '#111111', '#cc3333', '#3a944a', '#b58b00', '#3971ed', '#a36ac7', '#2f8f9d', '#d6d6d6',
  '#777777', '#ff6666', '#66c56f', '#e0b84b', '#6b9cff', '#c792ea', '#55c1d1', '#ffffff',
]

/** Format r/g/b channel values (0-255) as a CSS hex string. */
export function rgbHexDecode(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/** Maps a 256-color index to a hex string (16 base + 6x6x6 cube + grayscale ramp). */
export function color256Decode(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null
  if (index < 16) return ANSI_256_BASE[index] ?? null
  if (index < 232) {
    const offset = index - 16
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40)
    return rgbHexDecode(level(Math.floor(offset / 36)), level(Math.floor((offset % 36) / 6)), level(offset % 6))
  }
  const gray = 8 + (index - 232) * 10
  return rgbHexDecode(gray, gray, gray)
}

/**
 * Map a standard ANSI color index (0–15, corresponding to the ANSI_COLORS keys
 * 30–37 / 90–97) to a hex string. Returns null for out-of-range values.
 *
 * @param index - 0-based ANSI index (0=black, 1=red, … 7=light-grey, 8=dark-grey, … 15=white)
 */
export function ansiIndexToHex(index: number): string | null {
  return ANSI_256_BASE[index] ?? null
}

/**
 * xterm.js packed color modes, as returned by getFgColorMode()/getBgColorMode().
 * These are the CM_* constants from xterm.js's AttributeData — stable across
 * versions and confirmed against @xterm/headless (getFgColor()'s switch):
 *   DEFAULT (0)          — no explicit color; getFgColor() returns -1
 *   P16     (0x1000000)  — basic 16-color palette; color is index 0–15
 *   P256    (0x2000000)  — 256-color palette; color is index 0–255
 *   RGB     (0x3000000)  — truecolor; color is 24-bit packed 0xRRGGBB
 *
 * NOTE: P256 is 0x2000000 and RGB is 0x3000000. Mislabeling P256 as RGB makes a
 * palette index (e.g. 235) get bit-unpacked into r=0/g=0/b=235 → blue.
 */
export const XTERM_COLOR_MODE = {
  DEFAULT: 0,
  P16: 0x1000000,
  P256: 0x2000000,
  RGB: 0x3000000,
} as const

/**
 * Decode an xterm.js cell color value + mode (as returned by getFgColor()/
 * getFgColorMode() and the bg equivalents) to a hex string, or null for the
 * terminal default color.
 *
 * P16 and P256 both carry a palette index — decoded via color256Decode, whose
 * first 16 entries are the basic ANSI palette, so the same path serves both.
 * RGB carries a 24-bit packed 0xRRGGBB value.
 *
 * @param color - raw value from getFgColor()/getBgColor()
 * @param mode  - raw value from getFgColorMode()/getBgColorMode()
 */
export function decodeXtermColor(color: number, mode: number): string | null {
  if (mode === XTERM_COLOR_MODE.DEFAULT || color === -1) return null
  if (mode === XTERM_COLOR_MODE.P16 || mode === XTERM_COLOR_MODE.P256) {
    return color256Decode(color)
  }
  if (mode === XTERM_COLOR_MODE.RGB) {
    const r = (color >> 16) & 0xff
    const g = (color >> 8) & 0xff
    const b = color & 0xff
    return rgbHexDecode(r, g, b)
  }
  return null
}
