// Kitty terminal graphics protocol support.
//
// Detection: check env vars that Kitty sets unconditionally. No APC query
// roundtrip needed - the KITTY_WINDOW_ID var is always present inside a
// Kitty window and unambiguous.
//
// Encoding: PNG blobs are sent via the `a=T,f=100` path (direct PNG
// transmit). The terminal reads pixel dimensions from the PNG header.
// c/r constrain the rendered cell budget to the message pane width and
// the configured max-row budget so a 4K screenshot doesn't take over the
// whole terminal.
//
// Chunking: each APC payload may carry at most 4096 bytes of base64.
// Multi-chunk transmissions set m=1 on all but the final chunk.

const MAX_B64_CHUNK = 4096
// Cell aspect used to work out how many rows an image needs to fill a given
// column budget. Measured on Ghostty (CSI 16 t reports 22x41px) the real
// figure is 0.537, so this errs ~7% low and images come out slightly
// narrower than the pane allows. That is the safe direction - overshooting
// would push a picture past the pane edge - and asking the terminal at
// startup costs a stdin round-trip before Ink takes raw mode. See
// scripts/kitty-probe.ts.
const DEFAULT_CELL_WIDTH_TO_HEIGHT = 0.5
export const TEAMINAL_KITTY_Z = 17_042

export type KittyPlacement = {
  cols?: number
  rows?: number
  reservedRows: number
}

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp'

// Sniff the image format from the leading magic bytes. Used to decide
// whether a cached blob can be handed to the terminal as-is (Kitty only
// natively decodes PNG) and to label non-rendered placeholders.
export function detectImageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length < 4) return null
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png'
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  // "GIF87a" / "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif'
  // "RIFF" .... "WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp'
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  return null
}

// The Kitty graphics protocol's f=100 path decodes PNG only. JPEG/GIF/WebP
// blobs sent down that path are silently dropped by the terminal, which is
// what left photos and picker GIFs as blank reserved rows. Callers gate
// both the APC emit and the reserved layout on this so non-PNG images fall
// back to a labeled placeholder instead of empty space.
export function isKittyRenderable(buf: Buffer): boolean {
  return detectImageFormat(buf) === 'png'
}

// Kitty itself, Ghostty, and WezTerm all implement the Kitty graphics
// protocol. Detection is env-based - no APC query roundtrip needed.
export function isKittyCapable(): boolean {
  const term = process.env.TERM ?? ''
  const termProg = process.env.TERM_PROGRAM ?? ''
  return !!(
    process.env.KITTY_WINDOW_ID ||
    process.env.GHOSTTY_RESOURCES_DIR ||
    process.env.WEZTERM_EXECUTABLE ||
    term === 'xterm-kitty' ||
    term === 'xterm-ghostty' ||
    term === 'wezterm' ||
    termProg === 'kitty' ||
    termProg === 'ghostty' ||
    termProg === 'WezTerm'
  )
}

// Images whose natural height is under this many pixels are stickers, inline
// icons, or emoji-as-image. Scaling them up to the uniform display height
// would balloon them, so their row count shrinks proportionally.
const SMALL_IMAGE_PX = 200

// Fit an image into at most `maxCols` x `maxRows` cells.
//
// Always placed by ROWS (`r=`), never by columns: with `c=` alone the terminal
// derives the height itself from its real cell metrics, which can exceed the
// rows we reserved in the layout — and the picture then paints over the next
// message. Constraining rows makes the painted height exactly `reservedRows`
// (confirmed on Ghostty: r=6/10/14 paint 6/10/14 rows),
// so an inline image can never overlap text vertically no matter what the
// terminal's cell aspect turns out to be. Width is derived by the terminal
// from the aspect ratio at that height, bounded by picking rows that keep it
// within `maxCols`.
export function fitKittyPlacement(
  image: Buffer,
  maxCols: number,
  maxRows: number,
  opts?: { cellWidthToHeight?: number },
): KittyPlacement {
  const maxColsFloored = Math.max(1, Math.floor(maxCols))
  const maxRowsFloored = Math.max(1, Math.floor(maxRows))
  const size = readPngSize(image)
  if (!size) return { rows: maxRowsFloored, reservedRows: maxRowsFloored }

  const cellWidthToHeight = opts?.cellWidthToHeight ?? DEFAULT_CELL_WIDTH_TO_HEIGHT
  // Rows at which the aspect-preserved width exactly fills maxCols. Floored so
  // a rounding error shrinks the picture rather than overflowing the pane.
  const rowsAtMaxWidth = Math.max(
    1,
    Math.floor((maxColsFloored * size.height * cellWidthToHeight) / size.width),
  )
  let rows = Math.min(maxRowsFloored, rowsAtMaxWidth)
  if (size.height < SMALL_IMAGE_PX) {
    rows = Math.max(1, Math.round(rows * (size.height / SMALL_IMAGE_PX)))
  }
  return { rows, reservedRows: rows }
}

// Kitty image ids we own. Based well away from 0 so a placement can't collide
// with another program's image in the same terminal.
const KITTY_ID_BASE = 1_704_200
let nextKittyId = KITTY_ID_BASE
const idByCacheKey = new Map<string, number>()
const transmitted = new Set<number>()

// Stable terminal-side id for a cached blob, assigned on first use.
export function kittyImageId(cacheKey: string): number {
  let id = idByCacheKey.get(cacheKey)
  if (id === undefined) {
    id = nextKittyId++
    idByCacheKey.set(cacheKey, id)
  }
  return id
}

/**
 * Escape sequence that displays a blob at `placement`.
 *
 * The first time a blob is shown this transmits the pixels (~1.2MB of base64
 * for a screenshot). Every later paint places the copy the terminal already
 * holds, which is about 40 bytes — so scrolling past an image re-places it
 * instead of re-sending it. Relies on clearKittyImages() deleting placements
 * only (`d=z`) and never the data (`d=Z`).
 */
export function buildKittyImageEscape(
  cacheKey: string,
  png: Buffer,
  placement: KittyPlacement,
): string {
  const id = kittyImageId(cacheKey)
  if (transmitted.has(id)) return buildKittyPlaceById(id, placement)
  const apc = buildKittyAPC(png, placement, id)
  if (apc) transmitted.add(id)
  return apc
}

// Place an already-transmitted image by id, without resending its pixels.
export function buildKittyPlaceById(imageId: number, placement: KittyPlacement): string {
  const dimensions = kittyDimensions(placement)
  if (!dimensions) return ''
  return `\x1b_Ga=p,i=${imageId},${dimensions},C=1,z=${TEAMINAL_KITTY_Z},q=2\x1b\\`
}

// Returns the APC escape sequence string for an image blob.
// Placement uses either cols or rows, not both, so terminals preserve
// aspect ratio instead of stretching to an arbitrary cell rectangle.
export function buildKittyAPC(png: Buffer, placement: KittyPlacement, imageId?: number): string {
  // f=100 is the PNG transmit path; non-PNG blobs would be dropped by the
  // terminal, so refuse to emit a malformed escape for them.
  if (!isKittyRenderable(png)) return ''
  const b64 = png.toString('base64')
  if (!b64) return ''

  const dimensions = kittyDimensions(placement)
  if (!dimensions) return ''

  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += MAX_B64_CHUNK) {
    chunks.push(b64.slice(i, i + MAX_B64_CHUNK))
  }

  // `i=` names the image so later paints can place it without the pixels.
  const idKey = imageId === undefined ? '' : `i=${imageId},`
  if (chunks.length === 1) {
    return `\x1b_Ga=T,f=100,${idKey}${dimensions},C=1,z=${TEAMINAL_KITTY_Z},q=2,m=0;${chunks[0]}\x1b\\`
  }

  const parts: string[] = []
  parts.push(
    `\x1b_Ga=T,f=100,${idKey}${dimensions},C=1,z=${TEAMINAL_KITTY_Z},q=2,m=1;${chunks[0]}\x1b\\`,
  )
  for (let i = 1; i < chunks.length - 1; i++) {
    parts.push(`\x1b_Gm=1;${chunks[i]}\x1b\\`)
  }
  parts.push(`\x1b_Gm=0;${chunks[chunks.length - 1]}\x1b\\`)
  return parts.join('')
}

// Write the image at the current cursor position using an absolute
// cursor save/move/restore so Ink's cursor state is not disturbed.
// rowsFromBottom is the distance from the current cursor position
// (bottom of TUI) to the first row of the image area.
export function writeKittyImageAtOffset(
  stdout: NodeJS.WriteStream,
  apc: string,
  rowsFromBottom: number,
  imageRows: number,
  column = 1,
): void {
  if (!apc) return
  // \x1b7 = save cursor, \x1b8 = restore cursor
  // \x1b[{n}A = cursor up n rows, \x1b[{n}G = cursor to column n
  stdout.write(`\x1b7\x1b[${rowsFromBottom}A\x1b[${column}G${apc}\x1b[${imageRows}B\x1b8`)
}

// Remove our placements but KEEP the transmitted pixels in the terminal, so
// the next paint is a cheap place-by-id. Lowercase `d=z` deletes placements;
// uppercase `d=Z` would free the data and force a full resend every repaint.
export function clearKittyImages(stdout: NodeJS.WriteStream): void {
  stdout.write(`\x1b_Ga=d,d=z,z=${TEAMINAL_KITTY_Z},q=2\x1b\\`)
}

// Free the pixel data too, and forget our ids. Teardown only — during normal
// operation the cached data is exactly what makes re-placement cheap.
export function freeKittyImages(stdout: NodeJS.WriteStream): void {
  stdout.write(`\x1b_Ga=d,d=Z,z=${TEAMINAL_KITTY_Z},q=2\x1b\\`)
  idByCacheKey.clear()
  transmitted.clear()
}

export function __resetKittyImageIdsForTests(): void {
  idByCacheKey.clear()
  transmitted.clear()
  nextKittyId = KITTY_ID_BASE
}

function kittyDimensions(placement: KittyPlacement): string | null {
  if (placement.cols !== undefined) return `c=${Math.max(1, Math.floor(placement.cols))}`
  if (placement.rows !== undefined) return `r=${Math.max(1, Math.floor(placement.rows))}`
  return null
}

function readPngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[4] !== 0x0d ||
    buf[5] !== 0x0a ||
    buf[6] !== 0x1a ||
    buf[7] !== 0x0a
  ) {
    return null
  }
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}
