// Kitty text sizing protocol (OSC 66) for per-element font sizes.
// https://sw.kovidgoyal.net/kitty/text-sizing-protocol/
//
// Only fractional *down*-scaling is used: every grapheme still occupies its
// normal cell(s) (`w` = its cell width), just drawn with a smaller font. That
// keeps Ink's layout math exact. Scales above 1 (s >= 2) take s rows per
// line, which Ink cannot lay out, so they are deliberately not offered.
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
// style diff switches links without closing), or at the end of the chunk.
const RUN_RE = /\x1b\]8;;teaminal-fs:(\d+)\x07([\s\S]*?)(?:\x1b\]8;;\x07|(?=\x1b\]8;)|$)/g
// Non-text pieces inside a run that must pass through untouched.
const PASSTHROUGH_RE = /(\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|[\r\n])/
const segmenter = new Intl.Segmenter()

let supported = false

export function textSizingSupported(): boolean {
  return supported
}

export function __setTextSizingSupportedForTests(value: boolean): void {
  supported = value
}

// Wrap `text` so it renders at `pct`% of the base font size. A no-op at
// 100% or on terminals without OSC 66 support, so callers apply it blindly.
export function fs(text: string, pct: number): string {
  if (!supported || pct >= 100 || !text) return text
  return `${MARK}${Math.max(1, Math.round(pct / 10))}${BEL}${text}\x1b]8;;${BEL}`
}

export function expandTextSizing(chunk: string): string {
  if (!chunk.includes(MARK)) return chunk
  return chunk.replace(RUN_RE, (_, n: string, body: string) => {
    let out = ''
    for (const piece of body.split(PASSTHROUGH_RE)) {
      if (!piece) continue
      if (PASSTHROUGH_RE.test(piece)) {
        out += piece
        continue
      }
      for (const { segment } of segmenter.segment(piece)) {
        const w = Bun.stringWidth(segment)
        // Spaces and zero-width marks gain nothing from scaling.
        out +=
          w === 0 || segment === ' ' ? segment : `\x1b]66;n=${n}:d=10:v=1:w=${w};${segment}${BEL}`
      }
    }
    return out
  })
}

// Route Ink's frames through expandTextSizing. Idempotent per stream.
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
