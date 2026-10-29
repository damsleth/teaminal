// Profile pictures and team thumbnails as kitty images.
//
// Graph serves photos as JPEG, which the kitty protocol can't take directly
// (PNG or raw pixels only), so JPEGs are decoded in-process to RGBA once per
// image and sent as raw pixels. PNGs go through the normal PNG path. Each
// picture is placed into an exact cells box (c= and r=) so it can never paint
// over the text beside it.

import { decode } from 'jpeg-js'
import {
  buildKittyImageEscape,
  buildKittyRawEscape,
  detectImageFormat,
  getCellWidthToHeight,
} from './kittyGraphics'

export type AvatarSize = 'off' | 'small' | 'medium' | 'large'

// Rows a picture of this size takes; 0 for off.
export function avatarRows(size: AvatarSize): number {
  return size === 'small' ? 1 : size === 'medium' ? 2 : size === 'large' ? 3 : 0
}

// Columns for a square picture `rows` tall, at the terminal's cell aspect.
export function avatarCols(rows: number): number {
  return rows > 0 ? Math.max(1, Math.round(rows / getCellWidthToHeight())) : 0
}

// Graph photo edge in pixels for a size: the smallest that stays sharp.
export function avatarPixels(rows: number): 48 | 96 {
  return rows <= 2 ? 48 : 96
}

type Pixels = { rgba: Uint8Array; width: number; height: number }
// Decoded JPEGs by owned image key; null = not decodable.
const decoded = new Map<string, Pixels | null>()

function decodeJpeg(key: string, data: Buffer): Pixels | null {
  if (decoded.has(key)) return decoded.get(key)!
  let pixels: Pixels | null = null
  try {
    const img = decode(data, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4 })
    pixels = { rgba: img.data, width: img.width, height: img.height }
  } catch {
    pixels = null
  }
  decoded.set(key, pixels)
  return pixels
}

// Presence drawn onto a picture, Teams-style: a dot in the bottom-right
// corner (badge) or a solid strip down the left edge, like old Lync (bar).
export type PresenceStamp = { rgb: [number, number, number]; style: 'badge' | 'bar' }

// Stamped copies by stamped key, so a repaint doesn't redraw them.
// ponytail: unbounded, one small entry per (picture, presence color) seen.
const stampedPixels = new Map<string, Pixels>()

function withStamp(
  key: string,
  pixels: Pixels,
  stamp: PresenceStamp | undefined,
): { key: string; pixels: Pixels } {
  if (!stamp) return { key, pixels }
  const stampedKey = `${key}|${stamp.style}:${stamp.rgb.join(',')}`
  let out = stampedPixels.get(stampedKey)
  if (!out) {
    out = stampPresence(pixels, stamp)
    stampedPixels.set(stampedKey, out)
  }
  return { key: stampedKey, pixels: out }
}

// A copy of `pixels` with the presence drawn on; the source stays untouched
// (decoded photos and icons are cached).
export function stampPresence(pixels: Pixels, stamp: PresenceStamp): Pixels {
  const { width: w, height: h } = pixels
  const rgba = new Uint8Array(pixels.rgba)
  const n = Math.min(w, h)
  const r = 0.2 * n
  const cx = w - r - 0.04 * n
  const cy = h - r - 0.04 * n
  const bar = Math.max(2, Math.round(0.12 * w))
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const on =
        stamp.style === 'bar' ? x < bar : (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r
      if (!on) continue
      const i = (y * w + x) * 4
      rgba[i] = stamp.rgb[0]
      rgba[i + 1] = stamp.rgb[1]
      rgba[i + 2] = stamp.rgb[2]
      rgba[i + 3] = 255
    }
  return { rgba, width: w, height: h }
}

// Kitty escape placing `data` (PNG or JPEG) into rows x avatarCols(rows)
// cells; '' when the image can't be shown. Only JPEGs (what Graph serves for
// people) take a presence stamp: PNGs go to the terminal undecoded.
export function avatarEscape(
  ownedKey: string,
  data: Buffer,
  rows: number,
  stamp?: PresenceStamp,
): string {
  const placement = { rows, cols: avatarCols(rows), reservedRows: rows, exact: true }
  const format = detectImageFormat(data)
  if (format === 'png') return buildKittyImageEscape(ownedKey, data, placement)
  if (format !== 'jpeg') return ''
  const pixels = decodeJpeg(ownedKey, data)
  if (!pixels) return ''
  const s = withStamp(ownedKey, pixels, stamp)
  return buildKittyRawEscape(s.key, s.pixels, placement)
}

// Chat-type icons drawn as pictures, so group and meeting chats get a mark
// the same size as the photos beside them (a text glyph can't grow past one
// row in most terminals). Keys: icon:<group|meeting>:<r>,<g>,<b>.
export type ChatIcon = 'group' | 'meeting'

export function iconKey(icon: ChatIcon, rgb: [number, number, number]): string {
  return `icon:${icon}:${rgb.join(',')}`
}

export function isIconKey(key: string): boolean {
  return key.startsWith('icon:')
}

const ICON_PX = 48
const icons = new Map<string, Pixels>()

// Pixels for an icon key: shapes in the given color on a transparent ground.
function iconPixels(key: string): Pixels | null {
  const cached = icons.get(key)
  if (cached) return cached
  const [, icon, rgbText] = key.split(':')
  const rgb = (rgbText ?? '').split(',').map(Number)
  if ((icon !== 'group' && icon !== 'meeting') || rgb.length !== 3) return null
  const n = ICON_PX
  const rgba = new Uint8Array(n * n * 4)
  const inside = icon === 'group' ? groupShape : calendarShape
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!inside(x + 0.5, y + 0.5, n)) continue
      const i = (y * n + x) * 4
      rgba[i] = rgb[0]!
      rgba[i + 1] = rgb[1]!
      rgba[i + 2] = rgb[2]!
      rgba[i + 3] = 255
    }
  const pixels = { rgba, width: n, height: n }
  icons.set(key, pixels)
  return pixels
}

// Two people: a head (circle) over shoulders (top half of an ellipse). The
// one behind sits up and to the right, with a thin gap cut around the one in
// front so the two read as separate figures in a single color.
function groupShape(x: number, y: number, n: number): boolean {
  const person = (cx: number, top: number, s: number, grow = 0): boolean => {
    const r = 0.13 * n * s
    const hy = top + r
    if ((x - cx) ** 2 + (y - hy) ** 2 <= (r + grow) ** 2) return true
    const by = hy + 2.9 * r
    const rx = 2 * r + grow
    const ry = 1.7 * r + grow
    return y <= by + grow && ((x - cx) / rx) ** 2 + ((y - by) / ry) ** 2 <= 1
  }
  const front = (grow = 0) => person(0.4 * n, 0.3 * n, 1.15, grow)
  return front() || (person(0.68 * n, 0.2 * n, 0.95) && !front(0.05 * n))
}

// A calendar page: an outline with a solid header band, two binder rings
// and a 3 x 2 grid of day squares.
function calendarShape(x: number, y: number, n: number): boolean {
  const l = 0.14 * n
  const r = 0.86 * n
  const t = 0.2 * n
  const b = 0.86 * n
  const w = 0.06 * n
  if (
    y >= 0.12 * n &&
    y <= 0.28 * n &&
    (Math.abs(x - 0.34 * n) < w / 2 || Math.abs(x - 0.66 * n) < w / 2)
  )
    return true
  if (x < l || x > r || y < t || y > b) return false
  if (y < t + 0.16 * n) return true
  if (x < l + w || x > r - w || y > b - w) return true
  const gx = (x - (l + 0.12 * n)) / (0.2 * n)
  const gy = (y - (t + 0.26 * n)) / (0.2 * n)
  return gx >= 0 && gx < 3 && gy >= 0 && gy < 2 && gx % 1 < 0.6 && gy % 1 < 0.6
}

// Initials drawn as a picture: centered letters on a neutral square, the
// same size as a photo, for people (and teams) without one. Letters come
// from a 5x7 pixel font scaled by whole pixels, so they stay crisp.
// Key: initials:<letters>.
export function initialsKey(initials: string): string | null {
  const letters = Array.from(initials.toUpperCase())
    .map((c) => (GLYPHS[c] ? c : c.normalize('NFD').replace(/\p{M}/gu, '')))
    .filter((c) => GLYPHS[c])
    .slice(0, 2)
    .join('')
  return letters ? `initials:${letters}` : null
}

const INITIALS_PX = 66
// ponytail: fixed neutral gray with white letters reads on light and dark
// themes alike; make it a theme token if anyone wants it tinted.
const INITIALS_BG: [number, number, number] = [140, 140, 140]
const INITIALS_FG: [number, number, number] = [255, 255, 255]

function initialsPixels(key: string): Pixels | null {
  const letters = Array.from(key.slice('initials:'.length))
  if (letters.length === 0 || letters.some((c) => !GLYPHS[c])) return null
  const n = INITIALS_PX
  const rgba = new Uint8Array(n * n * 4)
  const paint = (x: number, y: number, rgb: [number, number, number]) => {
    const i = (y * n + x) * 4
    rgba[i] = rgb[0]
    rgba[i + 1] = rgb[1]
    rgba[i + 2] = rgb[2]
    rgba[i + 3] = 255
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) paint(x, y, INITIALS_BG)
  // Text box: 5 px per letter, 1 px between, 7 px tall; scale it to about
  // 55% of the square's width, then center it.
  const textW = letters.length * 6 - 1
  const k = Math.max(1, Math.min(Math.floor((n * 0.55) / textW), Math.floor((n * 0.5) / 7)))
  const left = Math.floor((n - textW * k) / 2)
  const top = Math.floor((n - 7 * k) / 2)
  letters.forEach((c, li) => {
    const rows = GLYPHS[c]!
    for (let gy = 0; gy < 7; gy++)
      for (let gx = 0; gx < 5; gx++) {
        if (rows[gy]![gx] !== '#') continue
        for (let dy = 0; dy < k; dy++)
          for (let dx = 0; dx < k; dx++)
            paint(left + (li * 6 + gx) * k + dx, top + gy * k + dy, INITIALS_FG)
      }
  })
  return { rgba, width: n, height: n }
}

// 5x7 capitals, '#' = ink.
const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  Æ: ['.####', '#.#..', '#.#..', '#####', '#.#..', '#.#..', '#.###'],
  Ø: ['.###.', '#..##', '#.#.#', '#.#.#', '#.#.#', '##..#', '.###.'],
  Å: ['..#..', '.#.#.', '.###.', '#...#', '#####', '#...#', '#...#'],
  Ä: ['.#.#.', '.....', '.###.', '#...#', '#####', '#...#', '#...#'],
  Ö: ['.#.#.', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  Ü: ['.#.#.', '.....', '#...#', '#...#', '#...#', '#...#', '.###.'],
}

// Pictures drawn in-process: chat-type icons and initials.
export function isGeneratedKey(key: string): boolean {
  return isIconKey(key) || key.startsWith('initials:')
}

// Kitty escape for an icon / initials key into a rows x avatarCols(rows) box.
export function iconEscape(key: string, rows: number, stamp?: PresenceStamp): string {
  const pixels = key.startsWith('initials:') ? initialsPixels(key) : iconPixels(key)
  if (!pixels) return ''
  const s = withStamp(key, pixels, stamp)
  return buildKittyRawEscape(s.key, s.pixels, {
    rows,
    cols: avatarCols(rows),
    reservedRows: rows,
    exact: true,
  })
}

export function __resetAvatarDecodeCacheForTests(): void {
  decoded.clear()
  icons.clear()
  stampedPixels.clear()
}
