export type CellStyle = {
  fg: string | null
  bg: string | null
  bold: boolean
  inverse: boolean
}

export type Cell = CellStyle & {
  char: string
}

const ANSI_COLORS: Record<number, string> = {
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

function rgbHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

// Maps a 256-color index to a hex string (16 base + 6x6x6 cube + grayscale ramp).
function color256(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null
  if (index < 16) return ANSI_256_BASE[index] ?? null
  if (index < 232) {
    const offset = index - 16
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40)
    return rgbHex(level(Math.floor(offset / 36)), level(Math.floor((offset % 36) / 6)), level(offset % 6))
  }
  const gray = 8 + (index - 232) * 10
  return rgbHex(gray, gray, gray)
}

// Display width of a code point: 0 for combining/zero-width, 2 for East Asian wide, else 1.
function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0xfeff
  ) {
    return 0
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

const DEFAULT_STYLE: CellStyle = {
  fg: null,
  bg: null,
  bold: false,
  inverse: false,
}

type EscapeState = 'normal' | 'escape' | 'csi' | 'osc'

export class TerminalGrid {
  readonly cols: number
  readonly rows: number
  private grid: Cell[][]
  private cursorRow = 0
  private cursorCol = 0
  private style: CellStyle = { ...DEFAULT_STYLE }
  private escapeState: EscapeState = 'normal'
  private escapeBuffer = ''

  constructor(cols: number, rows: number) {
    if (!Number.isInteger(cols) || cols <= 0) throw new Error('cols must be a positive integer')
    if (!Number.isInteger(rows) || rows <= 0) throw new Error('rows must be a positive integer')
    this.cols = cols
    this.rows = rows
    this.grid = this.createGrid()
  }

  write(input: string): void {
    for (const char of input) {
      this.writeChar(char)
    }
  }

  snapshot(): Cell[][] {
    return this.grid.map((row) => row.map((cell) => ({ ...cell })))
  }

  toText(): string {
    return this.grid
      .map((row) =>
        row
          .map((cell) => cell.char)
          .join('')
          .trimEnd(),
      )
      .join('\n')
  }

  private writeChar(char: string): void {
    if (this.escapeState === 'osc') {
      if (char === '\u0007') this.resetEscape()
      else if (char === '\u001b') this.escapeState = 'escape'
      return
    }

    if (this.escapeState === 'escape') {
      if (char === '[') {
        this.escapeState = 'csi'
        this.escapeBuffer = ''
      } else if (char === ']') {
        this.escapeState = 'osc'
        this.escapeBuffer = ''
      } else if (char === 'c') {
        this.clear()
        this.resetEscape()
      } else {
        this.resetEscape()
      }
      return
    }

    if (this.escapeState === 'csi') {
      this.escapeBuffer += char
      if (char >= '@' && char <= '~') {
        this.handleCsi(this.escapeBuffer)
        this.resetEscape()
      }
      return
    }

    if (char === '\u001b') {
      this.escapeState = 'escape'
      this.escapeBuffer = ''
    } else if (char === '\r') {
      this.cursorCol = 0
    } else if (char === '\n') {
      this.lineFeed()
    } else if (char === '\b') {
      this.cursorCol = Math.max(0, this.cursorCol - 1)
    } else if (char >= ' ' && char !== '\u007f') {
      this.putPrintable(char)
    }
  }

  private putPrintable(char: string): void {
    const width = charWidth(char.codePointAt(0) ?? 0)
    if (width === 0) return // drop combining / zero-width marks rather than consuming a cell
    if (this.cursorCol + width > this.cols) {
      this.cursorCol = 0
      this.lineFeed()
    }
    this.grid[this.cursorRow]![this.cursorCol] = { char, ...this.style }
    this.cursorCol++
    if (width === 2 && this.cursorCol < this.cols) {
      // Reserve the trailing column with an empty continuation cell so following
      // text stays column-aligned and the glyph is not double-rendered.
      this.grid[this.cursorRow]![this.cursorCol] = { char: '', ...this.style }
      this.cursorCol++
    }
  }

  private lineFeed(): void {
    this.cursorRow++
    if (this.cursorRow < this.rows) return
    this.grid.shift()
    this.grid.push(this.createBlankRow())
    this.cursorRow = this.rows - 1
  }

  private handleCsi(sequence: string): void {
    const final = sequence.at(-1)
    if (!final) return
    const rawParams = sequence.slice(0, -1).replace(/[?><=]/g, '')
    const params = rawParams
      .split(';')
      .filter((part) => part.length > 0)
      .map((part) => Number(part))
      .filter((value) => Number.isFinite(value))

    if (final === 'm') {
      this.handleSgr(params.length > 0 ? params : [0])
    } else if (final === 'H' || final === 'f') {
      const row = Math.max(1, params[0] ?? 1)
      const col = Math.max(1, params[1] ?? 1)
      this.cursorRow = Math.min(this.rows - 1, row - 1)
      this.cursorCol = Math.min(this.cols - 1, col - 1)
    } else if (final === 'J') {
      this.handleEraseDisplay(params[0] ?? 0)
    } else if (final === 'K') {
      this.handleEraseLine(params[0] ?? 0)
    } else if (final === 'A') {
      this.cursorRow = Math.max(0, this.cursorRow - (params[0] || 1))
    } else if (final === 'B') {
      this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (params[0] || 1))
    } else if (final === 'C') {
      this.cursorCol = Math.min(this.cols - 1, this.cursorCol + (params[0] || 1))
    } else if (final === 'D') {
      this.cursorCol = Math.max(0, this.cursorCol - (params[0] || 1))
    } else if (final === 'G') {
      this.cursorCol = Math.min(this.cols - 1, Math.max(1, params[0] ?? 1) - 1)
    } else if (final === 'h' || final === 'l') {
      if (rawParams.includes('1049')) this.clear()
    }
  }

  private handleSgr(params: number[]): void {
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!
      if (param === 0) {
        this.style = { ...DEFAULT_STYLE }
      } else if (param === 1) {
        this.style.bold = true
      } else if (param === 22) {
        this.style.bold = false
      } else if (param === 7) {
        this.style.inverse = true
      } else if (param === 27) {
        this.style.inverse = false
      } else if (param === 39) {
        this.style.fg = null
      } else if (param === 49) {
        this.style.bg = null
      } else if ((param >= 30 && param <= 37) || (param >= 90 && param <= 97)) {
        this.style.fg = ANSI_COLORS[param] ?? null
      } else if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
        this.style.bg = ANSI_COLORS[param - 10] ?? null
      } else if (param === 38 || param === 48) {
        // Extended color: 38/48 ;5;n (256-color) or 38/48 ;2;r;g;b (truecolor).
        const mode = params[i + 1]
        let color: string | null = null
        if (mode === 5) {
          color = params[i + 2] === undefined ? null : color256(params[i + 2]!)
          i += 2
        } else if (mode === 2) {
          const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]]
          color = r === undefined || g === undefined || b === undefined ? null : rgbHex(r, g, b)
          i += 4
        }
        if (param === 38) this.style.fg = color
        else this.style.bg = color
      }
    }
  }

  private handleEraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.clear()
      return
    }
    if (mode === 1) {
      for (let row = 0; row <= this.cursorRow; row++) {
        const end = row === this.cursorRow ? this.cursorCol : this.cols - 1
        this.clearLineRange(row, 0, end)
      }
      return
    }
    for (let row = this.cursorRow; row < this.rows; row++) {
      const start = row === this.cursorRow ? this.cursorCol : 0
      this.clearLineRange(row, start, this.cols - 1)
    }
  }

  private handleEraseLine(mode: number): void {
    if (mode === 2) {
      this.clearLineRange(this.cursorRow, 0, this.cols - 1)
    } else if (mode === 1) {
      this.clearLineRange(this.cursorRow, 0, this.cursorCol)
    } else {
      this.clearLineRange(this.cursorRow, this.cursorCol, this.cols - 1)
    }
  }

  private clearLineRange(row: number, start: number, end: number): void {
    for (let col = Math.max(0, start); col <= Math.min(this.cols - 1, end); col++) {
      this.grid[row]![col] = this.blankCell()
    }
  }

  private clear(): void {
    this.grid = this.createGrid()
    this.cursorRow = 0
    this.cursorCol = 0
  }

  private resetEscape(): void {
    this.escapeState = 'normal'
    this.escapeBuffer = ''
  }

  private createGrid(): Cell[][] {
    return Array.from({ length: this.rows }, () => this.createBlankRow())
  }

  private createBlankRow(): Cell[] {
    return Array.from({ length: this.cols }, () => this.blankCell())
  }

  private blankCell(): Cell {
    return {
      char: ' ',
      ...DEFAULT_STYLE,
    }
  }
}
