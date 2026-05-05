// Bracketed-paste parser.
//
// When the terminal advertises support for bracketed paste mode (CSI
// ?2004h), pasted text arrives wrapped in CSI 200~ and CSI 201~ escape
// sequences:
//
//     <ESC>[200~ ... pasted text ... <ESC>[201~
//
// Ink emits raw input as a single string per useInput call, but pastes
// large enough to span multiple Bun stdin chunks may straddle two or
// more callbacks. The parser is therefore stateful: feed() takes a
// chunk and returns ParseResult holding zero or more typed events
// (paste start, paste payload, paste end, plain input) plus any
// leftover that didn't form a complete sequence yet.

const ESC = '\x1b'
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

export type ParseEvent = { kind: 'plain'; chars: string } | { kind: 'paste'; chars: string }

export type ParserState = {
  // True when the most recent feed observed CSI 200~ but no CSI 201~ yet.
  inPaste: boolean
  // Bytes of the last feed that look like the start of an unfinished
  // escape sequence (e.g. "<ESC>[20"). Carried into the next feed so we
  // don't emit them as plain input by mistake.
  buffered: string
}

export const initialParserState: ParserState = { inPaste: false, buffered: '' }

export function feed(
  state: ParserState,
  chunk: string,
): {
  state: ParserState
  events: ParseEvent[]
} {
  const events: ParseEvent[] = []
  let s = state.buffered + chunk
  let inPaste = state.inPaste

  while (s.length > 0) {
    if (inPaste) {
      const endIdx = s.indexOf(PASTE_END)
      if (endIdx === -1) {
        // No closing bracket yet; emit everything as paste payload but
        // keep the last few bytes buffered in case the terminator is
        // straddling the chunk boundary.
        const safe = Math.max(0, s.length - (PASTE_END.length - 1))
        if (safe > 0) {
          events.push({ kind: 'paste', chars: s.slice(0, safe) })
        }
        return { state: { inPaste: true, buffered: s.slice(safe) }, events }
      }
      if (endIdx > 0) {
        events.push({ kind: 'paste', chars: s.slice(0, endIdx) })
      }
      s = s.slice(endIdx + PASTE_END.length)
      inPaste = false
      continue
    }
    const startIdx = s.indexOf(PASTE_START)
    if (startIdx === -1) {
      // No start bracket. Emit plain input minus any trailing partial-ESC.
      const tailLen = trailingPartialEscapeLength(s)
      const emit = s.slice(0, s.length - tailLen)
      if (emit) events.push({ kind: 'plain', chars: emit })
      return { state: { inPaste: false, buffered: s.slice(s.length - tailLen) }, events }
    }
    if (startIdx > 0) {
      const before = s.slice(0, startIdx)
      events.push({ kind: 'plain', chars: before })
    }
    s = s.slice(startIdx + PASTE_START.length)
    inPaste = true
  }
  return { state: { inPaste, buffered: '' }, events }
}

// If `s` ends with what could be the prefix of a paste-bracket escape
// ("\x1b", "\x1b[", "\x1b[2", ..., "\x1b[200"), return the length of
// that prefix so the caller can buffer it for the next chunk.
function trailingPartialEscapeLength(s: string): number {
  if (s.length === 0) return 0
  const max = Math.min(PASTE_START.length - 1, s.length)
  for (let n = max; n > 0; n--) {
    const tail = s.slice(s.length - n)
    if (PASTE_START.startsWith(tail) || PASTE_END.startsWith(tail)) return n
  }
  return 0
}

export const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`
export const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`
