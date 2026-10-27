// Kitty text sizing protocol (OSC 66) for per-element font sizes.
// https://sw.kovidgoyal.net/kitty/text-sizing-protocol/
//
// Fractional *down*-scaling for font sizes. By default every grapheme keeps its
// normal cell(s) (`w` = its cell width), just drawn with a smaller font, so
// Ink's layout math stays exact. Tight runs pack several graphemes into fewer
// cells (`w` < their width) so letters sit at the scaled pitch, and pad the
// cells saved with blanks at the end of the run: same total width, the slack
// moves to the end. Larger text is not offered: s >= 2 takes s rows per
// line. The one s=2 use is fsTall, a 1.5x line at the bottom of two rows to
// get half a row of air above it; the rewriter steps over the block's lower
// half on the next line so Ink's layout there stays put.
//
// Ink can't carry OSC 66 itself: string-width strips the whole sequence
// (text included) and its cell model drops non-link OSCs. So components wrap
// sized text in an OSC 8 hyperlink with a private URI. Ink treats that as a
// zero-width style and preserves it through wrap, truncate and clip, and the
// patched stdout.write (installTextSizing) rewrites each marked run into
// per-grapheme OSC 66 escapes on its way to the terminal.

const MARK = '\x1b]8;;teaminal-fs:'
const BEL = '\x07'
// A run ends at the hyperlink close, or where another OSC 8 starts (Ink's
// style diff switches links without closing), or at the end of the line.
// Mode: '' per-cell, 't' tight (packed), 'T' tall (2-row block, see fsTall).
const RUN_RE = /\x1b\]8;;teaminal-fs:(\d+)([tT]?)\x07([\s\S]*?)(?:\x1b\]8;;\x07|(?=\x1b\]8;)|$)/g
// Escape sequences, which pass through untouched and take no columns.
const ESC_SPLIT = /(\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][\s\S]*?(?:\x07|\x1b\\))/
const segmenter = new Intl.Segmenter()

let supported = false

export function textSizingSupported(): boolean {
  return supported
}

export function __setTextSizingSupportedForTests(value: boolean): void {
  supported = value
}

// Wrap `text` so it renders at `pct`% of the base font size, packed to the
// scaled letter pitch when `tight`. A no-op at 100% or on terminals without
// OSC 66 support, so callers apply it blindly.
export function fs(text: string, pct: number, tight = false): string {
  if (!supported || pct >= 100 || !text) return text
  const n = Math.max(1, Math.round(pct / 10))
  return `${MARK}${n}${tight ? 't' : ''}${BEL}${text}\x1b]8;;${BEL}`
}

// Wrap one line of `text` as a "tall" line: drawn in 2-row blocks (s=2) at
// 1.5x `pct`% size, bottom-aligned, so at 100% it fills the lower 1.5 rows
// with half a row of air above and none below. The caller must reserve a
// blank row under it (Box height 2). Padded with the extra cells the wider
// glyphs take, so Ink lays out exactly the cells the blocks cover; the
// rewriter drops the padding again.
export function fsTall(text: string, pct: number): string {
  if (!supported || !text) return text
  const n = Math.max(1, Math.round((1.5 * Math.min(pct, 100)) / 10))
  const p = tallPacker(n)
  const width = Bun.stringWidth(text)
  const rem = width % p.len
  const cells = Math.floor(width / p.len) * p.cells(p.len) + (rem ? p.cells(rem) : 0)
  return `${MARK}${n}T${BEL}${text}${' '.repeat(Math.max(0, cells - width))}\x1b]8;;${BEL}`
}

// Cells of normal-width text per packed chunk at scale n/10: the length whose
// scaled width wastes the least of its ceil()'d cells, within the spec's w <= 7.
// null when packing saves nothing (90%: 7 cells hold only 7 characters).
export function packLength(n: number): number | null {
  let best: number | null = null
  let bestRatio = 1
  for (let len = 1; Math.ceil((len * n) / 10) <= 7; len++) {
    const ratio = Math.ceil((len * n) / 10) / len
    if (ratio < bestRatio) [best, bestRatio] = [len, ratio]
  }
  return best
}

// n/d (d <= 15, the spec's limit) closest to `target`.
export function nearestFraction(target: number): [number, number] {
  let best: [number, number] = [1, 2]
  for (let d = 2; d <= 15; d++) {
    for (let n = 1; n < d; n++) {
      if (Math.abs(n / d - target) < Math.abs(best[0] / best[1] - target)) best = [n, d]
    }
  }
  return best
}

type Packer = {
  len: number
  cells: (width: number) => number
  emit: (cells: number, text: string) => string
}

function cell(n: number, w: number, text: string): string {
  return `\x1b]66;n=${n}:d=10:v=1:w=${w};${text}${BEL}`
}

// s=2 blocks are 2 rows tall and 2*w cells wide; the fraction scales the
// font to n/10 of normal inside them (up to 1.5x).
export function tallPacker(n: number): Packer {
  const [fn, fd] = nearestFraction(n / 20)
  const scale = (2 * fn) / fd
  const blocks = (width: number) => Math.max(1, Math.ceil((width * scale) / 2))
  let len = 1
  let bestRatio = Infinity
  for (let l = 1; Math.ceil((l * scale) / 2) <= 7; l++) {
    const ratio = (2 * blocks(l)) / l
    // Only take a longer chunk for a real gain: padding grows with it.
    if (ratio < bestRatio - 0.05) [len, bestRatio] = [l, ratio]
  }
  return {
    len,
    cells: (width) => 2 * blocks(width),
    emit: (cells, text) => `\x1b]66;s=2:n=${fn}:d=${fd}:v=1:w=${cells / 2};${text}${BEL}`,
  }
}

function packerFor(n: number, mode: string): Packer | null {
  if (mode === 'T') return tallPacker(n)
  const len = mode === 't' ? packLength(n) : null
  if (!len) return null
  return {
    len,
    cells: (width) => Math.max(1, Math.ceil((width * n) / 10)),
    emit: (cells, text) => cell(n, cells, text),
  }
}

function packed(piece: string, p: Packer): { out: string; saved: number } {
  let out = ''
  let saved = 0
  let chunk = ''
  let width = 0
  const flush = (): void => {
    if (!chunk) return
    const cells = p.cells(width)
    out += p.emit(cells, chunk)
    saved += width - cells
    chunk = ''
    width = 0
  }
  for (const { segment } of segmenter.segment(piece)) {
    const w = Bun.stringWidth(segment)
    if (w > 0 && width + w > p.len) flush()
    chunk += segment
    width += w
    if (width >= p.len) flush()
  }
  flush()
  return { out, saved }
}

type Token = { text: string; width: number; esc: boolean }

function* tokens(s: string): Generator<Token> {
  for (const piece of s.split(ESC_SPLIT)) {
    if (!piece) continue
    if (piece.charCodeAt(0) === 0x1b) {
      // Cursor-forward (emitted by skipCovered) is the one escape that moves.
      const fwd = /^\x1b\[(\d*)C$/.exec(piece)
      yield { text: piece, width: fwd ? Number(fwd[1] || 1) : 0, esc: true }
      continue
    }
    for (const { segment } of segmenter.segment(piece)) {
      yield { text: segment, width: Bun.stringWidth(segment), esc: false }
    }
  }
}

function columns(s: string): number {
  let cols = 0
  for (const t of tokens(s)) cols += t.width
  return cols
}

function expandRun(n: number, mode: string, body: string): string {
  const p = packerFor(n, mode)
  const pieces = body.split(ESC_SPLIT)
  // Padding goes right after the last text piece, before the closing SGR
  // codes, so a row background still covers it.
  let lastText = -1
  pieces.forEach((piece, i) => {
    if (piece && piece.charCodeAt(0) !== 0x1b) lastText = i
  })
  let out = ''
  let saved = 0
  pieces.forEach((piece, i) => {
    if (!piece) return
    if (piece.charCodeAt(0) === 0x1b) {
      out += piece
    } else if (p) {
      // Tall runs end in fsTall's reserve padding: give it back as plain
      // cells after the blocks instead of drawing it at 1.5x.
      if (mode === 'T' && i === lastText) {
        const trimmed = piece.trimEnd()
        saved += piece.length - trimmed.length
        piece = trimmed
      }
      const r = packed(piece, p)
      out += r.out
      saved += r.saved
    } else {
      for (const { segment } of segmenter.segment(piece)) {
        const w = Bun.stringWidth(segment)
        // Spaces and zero-width marks gain nothing from scaling.
        out += w === 0 || segment === ' ' ? segment : cell(n, w, segment)
      }
    }
    // ponytail: a wide char straddling a block boundary can overshoot by a
    // cell (saved < 0); that line then shifts right by one. Rare in names.
    if (i === lastText) out += ' '.repeat(Math.max(0, saved))
  })
  return out
}

type Range = [number, number]

// Expand the runs of one frame line; report the columns tall blocks cover
// on the line below.
function expandLine(line: string): { text: string; tall: Range[] } {
  const tall: Range[] = []
  let out = ''
  let last = 0
  for (const m of line.matchAll(RUN_RE)) {
    const [whole, n, mode, body] = m as unknown as [string, string, string, string]
    out += line.slice(last, m.index)
    if (mode === 'T') {
      const col = columns(line.slice(0, m.index))
      tall.push([col, col + columns(body)])
    }
    out += expandRun(Number(n), mode, body)
    last = m.index! + whole.length
  }
  return { text: out + line.slice(last), tall }
}

// A tall block's lower half lives on the next frame line. Kitty moves any
// text written into those cells past the block (shifting the rest of the
// line), so step over them with cursor-forward instead of writing Ink's
// blanks there.
function skipCovered(line: string, ranges: Range[]): string {
  const covered = (c: number) => ranges.some(([a, b]) => c >= a && c < b)
  let out = ''
  let col = 0
  let skip = 0
  for (const t of tokens(line)) {
    if (!t.esc && t.width > 0 && covered(col)) {
      skip += t.width
      col += t.width
      continue
    }
    if (skip) {
      out += `\x1b[${skip}C`
      skip = 0
    }
    out += t.text
    col += t.width
  }
  // A trailing skip has nothing after it to place: drop it.
  return out
}

export function expandTextSizing(chunk: string): string {
  if (!chunk.includes(MARK)) return chunk
  let covered: Range[] = []
  return chunk
    .split('\n')
    .map((raw) => {
      const line = covered.length ? skipCovered(raw, covered) : raw
      const { text, tall } = line.includes(MARK) ? expandLine(line) : { text: line, tall: [] }
      covered = tall
      return text
    })
    .join('\n')
}

// Route Ink's frames through expandTextSizing. Install once per stream.
export function installTextSizing(stream: NodeJS.WriteStream): void {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean
  stream.write = ((chunk: unknown, ...rest: unknown[]) =>
    original(
      typeof chunk === 'string' ? expandTextSizing(chunk) : chunk,
      ...rest,
    )) as typeof stream.write
}

// Three cursor position reports around a w=2 and an s=2 draw, per the
// spec's detection recipe: the s=2 draw only advances the cursor on
// terminals that implement scaling.
export function parseTextSizingProbe(reply: string): boolean | null {
  const cols = [...reply.matchAll(/\x1b\[\d+;(\d+)R/g)].map((m) => Number(m[1]))
  if (cols.length < 3) return null
  return cols[2]! - cols[1]! === 2
}

/**
 * Detect OSC 66 scale support. Same pre-Ink rules as probeCellAspect: must
 * run before Ink owns stdin, and must not pause stdin inside its own 'data'
 * handler (AGENTS.md pitfall 10).
 */
export async function probeTextSizing(timeoutMs = 150): Promise<boolean> {
  const { stdin, stdout } = process
  if (!stdin.isTTY || !stdout.isTTY) return false
  const wasRaw = stdin.isRaw
  let done = false
  return new Promise<boolean>((resolve) => {
    let acc = ''
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.pause()
      if (!wasRaw) stdin.setRawMode(false)
      // Wipe the probe's blank cells (the s=2 one spans the row below too).
      stdout.write('\r\x1b[J')
      supported = ok
      resolve(ok)
    }
    const onData = (chunk: Buffer): void => {
      acc += chunk.toString('binary')
      const ok = parseTextSizingProbe(acc)
      if (ok !== null) setImmediate(() => finish(ok))
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    try {
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onData)
      stdout.write('\r\x1b[6n\x1b]66;w=2; \x07\x1b[6n\x1b]66;s=2; \x07\x1b[6n')
    } catch {
      finish(false)
    }
  })
}
