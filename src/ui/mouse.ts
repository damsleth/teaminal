// SGR mouse reports (modes 1000 + 1006) from raw stdin.
//
// With reporting on, the terminal sends ESC[<b;x;yM on press and ...m on
// release, x / y 1-based. Ink does not know these: it strips the ESC and
// hands "[<0;10;5M" to useInput as text, so the wrapper in ./useInput drops
// anything shaped like a report (isMouseReport) and the tracker parses the
// raw chunks itself (createMouseParser).
//
// Only presses, releases and the vertical wheel are decoded. Motion (drag,
// hover), the horizontal wheel and extended buttons are skipped, as is
// everything inside a bracketed paste, so pasted text can never click.

export type MouseEvent = {
  kind: 'down' | 'up' | 'wheel'
  button: 'left' | 'middle' | 'right' | null
  // -1 up, 1 down; wheel events only.
  wheel?: -1 | 1
  // 0-based cell.
  x: number
  y: number
  shift: boolean
  meta: boolean
  ctrl: boolean
}

export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h'
export const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1000l'

const ESC = '\x1b'
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`
// eslint-disable-next-line no-control-regex
const REPORT = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/
// eslint-disable-next-line no-control-regex
const REPORT_HEAD = /^\x1b(\[(<[\d;]*)?)?$/
// The longest report a real terminal sends is ~20 chars; anything longer
// still unfinished is garbage and is dropped rather than carried.
const MAX_PENDING = 32

const BUTTONS = ['left', 'middle', 'right', null] as const

function decode(code: string, cx: string, cy: string, final: string): MouseEvent | null {
  const b = Number(code)
  const x = Number(cx) - 1
  const y = Number(cy) - 1
  if (x < 0 || y < 0) return null
  // Motion, with or without a button: drag and hover are not supported.
  if (b & 32) return null
  const mods = { shift: (b & 4) !== 0, meta: (b & 8) !== 0, ctrl: (b & 16) !== 0 }
  const base = b & ~(4 | 8 | 16)
  if (base === 64 || base === 65) {
    // Terminals report the wheel as a press only.
    return final === 'M'
      ? { kind: 'wheel', button: null, wheel: base === 64 ? -1 : 1, x, y, ...mods }
      : null
  }
  // Horizontal wheel (66 / 67) and extended buttons (128+).
  if (base >= 64) return null
  const button = BUTTONS[base & 3]!
  if (button === null) return null
  return { kind: final === 'M' ? 'down' : 'up', button, x, y, ...mods }
}

// The tail of `s` from `from` that could be the start of `marker`, or ''.
function partialSuffix(s: string, from: number, marker: string): string {
  for (let n = Math.min(marker.length - 1, s.length - from); n > 0; n--) {
    if (marker.startsWith(s.slice(s.length - n))) return s.slice(s.length - n)
  }
  return ''
}

export type MouseParser = {
  push(chunk: string | Buffer): MouseEvent[]
  // Forget a half-read report or an open paste (disable, stop, editor).
  reset(): void
}

export function createMouseParser(): MouseParser {
  let pending = ''
  let inPaste = false
  return {
    push(chunk) {
      const s = pending + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      pending = ''
      const out: MouseEvent[] = []
      let i = 0
      while (i < s.length) {
        if (inPaste) {
          const end = s.indexOf(PASTE_END, i)
          if (end === -1) {
            pending = partialSuffix(s, i, PASTE_END)
            return out
          }
          inPaste = false
          i = end + PASTE_END.length
          continue
        }
        const esc = s.indexOf(ESC, i)
        if (esc === -1) break
        const rest = s.slice(esc)
        if (rest.startsWith(PASTE_START)) {
          inPaste = true
          i = esc + PASTE_START.length
          continue
        }
        const m = REPORT.exec(rest)
        if (m) {
          const event = decode(m[1]!, m[2]!, m[3]!, m[4]!)
          if (event) out.push(event)
          i = esc + m[0].length
          continue
        }
        // A report or paste marker cut at the chunk boundary: carry it.
        if (REPORT_HEAD.test(rest) || PASTE_START.startsWith(rest)) {
          if (rest.length <= MAX_PENDING) pending = rest
          break
        }
        i = esc + 1
      }
      return out
    },
    reset() {
      pending = ''
      inPaste = false
    },
  }
}

// Input that reached a useInput handler as a report Ink did not recognise: a
// whole one ("[<0;10;5M", the ESC stripped), or the head Ink flushed when the
// rest of the report came too late ("[<0;1"). The tail of such a split
// report ("0;5M") is indistinguishable from typing and gets through.
export function isMouseReport(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input) || /^\[<[\d;]*$/.test(input)
}
