import type { Cell } from './terminal'

const CELL_WIDTH = 8
const CELL_HEIGHT = 18
const FONT_SIZE = 14
const PADDING = 10
const DEFAULT_FG = '#d6d6d6'
const DEFAULT_BG = '#0b0f14'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sameStyle(a: Cell, b: Cell): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.inverse === b.inverse
}

// Resolve a cell's effective colors, swapping fg/bg (against the page defaults) for reverse video.
function resolveColors(cell: Cell): { fg: string; bg: string | null } {
  if (cell.inverse) {
    return { fg: cell.bg ?? DEFAULT_BG, bg: cell.fg ?? DEFAULT_FG }
  }
  return { fg: cell.fg ?? DEFAULT_FG, bg: cell.bg }
}

export function renderGridSvg(grid: Cell[][], label: string): string {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  const width = cols * CELL_WIDTH + PADDING * 2
  const height = rows * CELL_HEIGHT + PADDING * 2
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#0b0f14"/>',
    `<text x="${PADDING}" y="${PADDING - 2}" fill="#7f8b96" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11">${escapeXml(label)}</text>`,
    '<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14" xml:space="preserve">',
  ]

  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    const row = grid[rowIndex]!
    let col = 0
    while (col < cols) {
      const start = col
      const first = row[col]!
      let text = first.char
      col++
      while (col < cols && sameStyle(first, row[col]!)) {
        text += row[col]!.char
        col++
      }
      const { fg, bg } = resolveColors(first)
      // Skip only when there is nothing to draw — a background still renders for blank runs
      // (e.g. a selection bar or reverse-video padding), which would otherwise vanish.
      if (text.trim().length === 0 && !bg) continue
      const x = PADDING + start * CELL_WIDTH
      const y = PADDING + (rowIndex + 1) * CELL_HEIGHT
      const weight = first.bold ? '700' : '400'
      if (bg) {
        lines.push(
          `<rect x="${x}" y="${y - FONT_SIZE}" width="${(col - start) * CELL_WIDTH}" height="${CELL_HEIGHT}" fill="${bg}"/>`,
        )
      }
      if (text.trim().length > 0) {
        lines.push(
          `<text x="${x}" y="${y}" fill="${fg}" font-weight="${weight}">${escapeXml(text)}</text>`,
        )
      }
    }
  }

  lines.push('</g>', '</svg>')
  return `${lines.join('\n')}\n`
}
