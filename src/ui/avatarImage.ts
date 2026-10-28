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

export function __resetAvatarDecodeCacheForTests(): void {
  decoded.clear()
}
