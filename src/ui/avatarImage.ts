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

// Kitty escape placing `data` (PNG or JPEG) into rows x avatarCols(rows)
// cells; '' when the image can't be shown.
export function avatarEscape(ownedKey: string, data: Buffer, rows: number): string {
  const placement = { rows, cols: avatarCols(rows), reservedRows: rows, exact: true }
  const format = detectImageFormat(data)
  if (format === 'png') return buildKittyImageEscape(ownedKey, data, placement)
  if (format !== 'jpeg') return ''
  const pixels = decodeJpeg(ownedKey, data)
  return pixels ? buildKittyRawEscape(ownedKey, pixels, placement) : ''
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

// Kitty escape for an icon key into a rows x avatarCols(rows) box.
export function iconEscape(key: string, rows: number): string {
  const pixels = iconPixels(key)
  if (!pixels) return ''
  return buildKittyRawEscape(key, pixels, {
    rows,
    cols: avatarCols(rows),
    reservedRows: rows,
    exact: true,
  })
}

export function __resetAvatarDecodeCacheForTests(): void {
  decoded.clear()
  icons.clear()
}
