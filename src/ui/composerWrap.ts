// Soft-wrap the composer buffer into visual rows. Each row keeps its offset
// into the buffer so the cursor can be placed on the row it falls in. Rows
// break after the last space that fits, or hard at `width` for a long word.
// ponytail: one cell per UTF-16 unit; wide glyphs (CJK, emoji) overrun a row.

export type ComposerRow = { start: number; text: string; lineStart: boolean }

// Columns the composer gives its text: box border (2) + paddingX (2) +
// the `> ` prefix (2) + one cell for the cursor block at the row end.
export const COMPOSER_TEXT_CHROME = 7

export function wrapComposer(text: string, width: number): ComposerRow[] {
  const w = Math.max(1, width)
  const rows: ComposerRow[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    let rest = line
    let start = offset
    let lineStart = true
    while (rest.length > w) {
      const space = rest.lastIndexOf(' ', w - 1)
      const cut = space > 0 ? space + 1 : w
      rows.push({ start, text: rest.slice(0, cut), lineStart })
      start += cut
      rest = rest.slice(cut)
      lineStart = false
    }
    rows.push({ start, text: rest, lineStart })
    offset += line.length + 1
  }
  return rows
}

// Row index + column of a buffer offset. At a soft-wrap boundary the cursor
// belongs to the start of the next row, where the next typed char lands.
export function cursorRowCol(rows: ComposerRow[], cursor: number): { row: number; col: number } {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    if (cursor >= r.start) return { row: i, col: Math.min(cursor - r.start, r.text.length) }
  }
  return { row: 0, col: 0 }
}
