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
