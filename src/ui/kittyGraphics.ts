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

// Returns the APC escape sequence string for a PNG blob.
// cols/rows are terminal cell dimensions (not pixels).
export function buildKittyAPC(png: Buffer, cols: number, rows: number): string {
  const b64 = png.toString('base64')
  if (!b64) return ''

  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += MAX_B64_CHUNK) {
    chunks.push(b64.slice(i, i + MAX_B64_CHUNK))
  }

  if (chunks.length === 1) {
    return `\x1b_Ga=T,f=100,c=${cols},r=${rows},m=0;${chunks[0]}\x1b\\`
  }

  const parts: string[] = []
  parts.push(`\x1b_Ga=T,f=100,c=${cols},r=${rows},m=1;${chunks[0]}\x1b\\`)
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
): void {
  if (!apc) return
  // \x1b7 = save cursor, \x1b8 = restore cursor
  // \x1b[{n}A = cursor up n rows, \x1b[1G = cursor to column 1
  stdout.write(
    `\x1b7\x1b[${rowsFromBottom}A\x1b[1G${apc}\x1b[${imageRows}B\x1b8`,
  )
}
