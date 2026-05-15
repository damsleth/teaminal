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
const DEFAULT_CELL_WIDTH_TO_HEIGHT = 0.5
export const TEAMINAL_KITTY_Z = 17_042

export type KittyPlacement = {
  cols?: number
  rows?: number
  reservedRows: number
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

export function fitKittyPlacement(
  image: Buffer,
  maxCols: number,
  maxRows: number,
  opts?: { cellWidthToHeight?: number },
): KittyPlacement {
  const cols = Math.max(1, Math.floor(maxCols))
  const rows = Math.max(1, Math.floor(maxRows))
  const size = readPngSize(image)
  if (!size) return { rows, reservedRows: rows }

  const cellWidthToHeight = opts?.cellWidthToHeight ?? DEFAULT_CELL_WIDTH_TO_HEIGHT
  const heightForMaxWidth = Math.max(
    1,
    Math.ceil((cols * size.height * cellWidthToHeight) / size.width),
  )

  if (heightForMaxWidth <= rows) {
    return { cols, reservedRows: heightForMaxWidth }
  }
  return { rows, reservedRows: rows }
}

// Returns the APC escape sequence string for an image blob.
// Placement uses either cols or rows, not both, so terminals preserve
// aspect ratio instead of stretching to an arbitrary cell rectangle.
export function buildKittyAPC(png: Buffer, placement: KittyPlacement): string {
  const b64 = png.toString('base64')
  if (!b64) return ''

  const dimensions = kittyDimensions(placement)
  if (!dimensions) return ''

  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += MAX_B64_CHUNK) {
    chunks.push(b64.slice(i, i + MAX_B64_CHUNK))
  }

  if (chunks.length === 1) {
    return `\x1b_Ga=T,f=100,${dimensions},C=1,z=${TEAMINAL_KITTY_Z},q=2,m=0;${chunks[0]}\x1b\\`
  }

  const parts: string[] = []
  parts.push(`\x1b_Ga=T,f=100,${dimensions},C=1,z=${TEAMINAL_KITTY_Z},q=2,m=1;${chunks[0]}\x1b\\`)
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

export function clearKittyImages(stdout: NodeJS.WriteStream): void {
  stdout.write(`\x1b_Ga=d,d=Z,z=${TEAMINAL_KITTY_Z},q=2\x1b\\`)
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
