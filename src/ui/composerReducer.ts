// Pure reducer for the composer's text buffer + cursor.
//
// Separated from the React component so the cursor / motion / deletion
// logic can be exhaustively unit-tested without touching Ink. The
// reducer takes a ComposerBuffer (text + cursor index) plus an action,
// and returns a new ComposerBuffer.
//
// Conventions:
//   - cursor is a count of UTF-16 code units (matches String#length /
//     String#slice). teaminal does not need grapheme-level cursoring
//     until someone reports an emoji-cursor bug.
//   - cursor === 0 means before the first char; cursor === text.length
//     means after the last char (end-of-buffer).
//   - All actions clamp the cursor to [0, text.length].

export type ComposerBuffer = {
  text: string
  cursor: number
}

export const emptyBuffer: ComposerBuffer = { text: '', cursor: 0 }

export type ComposerAction =
  | { kind: 'insert'; chars: string }
  | { kind: 'newline' }
  | { kind: 'backspace' }
  | { kind: 'delete-forward' } // not bound today; future Delete key
  | { kind: 'delete-prev-word' } // Ctrl+W / Alt+Backspace
  | { kind: 'delete-to-line-start' } // Ctrl+U
  | { kind: 'delete-to-line-end' } // Ctrl+K
  | { kind: 'cursor-left' }
  | { kind: 'cursor-right' }
  | { kind: 'cursor-prev-word' }
  | { kind: 'cursor-next-word' }
  | { kind: 'cursor-line-start' } // Home / Ctrl+A
  | { kind: 'cursor-line-end' } // End / Ctrl+E
  | { kind: 'cursor-buffer-start' }
  | { kind: 'cursor-buffer-end' }
  | { kind: 'set-text'; text: string; cursor?: number }

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function lineBoundsAt(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', cursor - 1) + 1
  const nextNl = text.indexOf('\n', cursor)
  const end = nextNl === -1 ? text.length : nextNl
  return { start, end }
}

// Word boundaries: a "word" is a maximal run of \w (alphanumeric +
// underscore). delete-prev-word skips trailing whitespace then deletes
// the run; same shape as readline's default kill-word.
function wordStartBefore(text: string, cursor: number): number {
  let i = cursor
  while (i > 0 && /\s/.test(text[i - 1]!)) i--
  while (i > 0 && /\S/.test(text[i - 1]!)) i--
  return i
}

function wordEndAfter(text: string, cursor: number): number {
  let i = cursor
  while (i < text.length && /\s/.test(text[i]!)) i++
  while (i < text.length && /\S/.test(text[i]!)) i++
  return i
}

export function reduce(state: ComposerBuffer, action: ComposerAction): ComposerBuffer {
  const { text, cursor } = state
  switch (action.kind) {
    case 'insert': {
      const chars = action.chars
      if (!chars) return state
      return {
        text: text.slice(0, cursor) + chars + text.slice(cursor),
        cursor: cursor + chars.length,
      }
    }
    case 'newline':
      return reduce(state, { kind: 'insert', chars: '\n' })
    case 'backspace': {
      if (cursor === 0) return state
      return {
        text: text.slice(0, cursor - 1) + text.slice(cursor),
        cursor: cursor - 1,
      }
    }
    case 'delete-forward': {
      if (cursor >= text.length) return state
      return {
        text: text.slice(0, cursor) + text.slice(cursor + 1),
        cursor,
      }
    }
    case 'delete-prev-word': {
      const target = wordStartBefore(text, cursor)
      if (target === cursor) return state
      return {
        text: text.slice(0, target) + text.slice(cursor),
        cursor: target,
      }
    }
    case 'delete-to-line-start': {
      const { start } = lineBoundsAt(text, cursor)
      if (start === cursor) return state
      return {
        text: text.slice(0, start) + text.slice(cursor),
        cursor: start,
      }
    }
    case 'delete-to-line-end': {
      const { end } = lineBoundsAt(text, cursor)
      if (end === cursor) {
        // At end of line: delete the newline (join with next).
        if (cursor < text.length) {
          return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor }
        }
        return state
      }
      return {
        text: text.slice(0, cursor) + text.slice(end),
        cursor,
      }
    }
    case 'cursor-left':
      return { text, cursor: clamp(cursor - 1, 0, text.length) }
    case 'cursor-right':
      return { text, cursor: clamp(cursor + 1, 0, text.length) }
    case 'cursor-prev-word':
      return { text, cursor: wordStartBefore(text, cursor) }
    case 'cursor-next-word':
      return { text, cursor: wordEndAfter(text, cursor) }
    case 'cursor-line-start':
      return { text, cursor: lineBoundsAt(text, cursor).start }
    case 'cursor-line-end':
      return { text, cursor: lineBoundsAt(text, cursor).end }
    case 'cursor-buffer-start':
      return { text, cursor: 0 }
    case 'cursor-buffer-end':
      return { text, cursor: text.length }
    case 'set-text':
      return {
        text: action.text,
        cursor: clamp(action.cursor ?? action.text.length, 0, action.text.length),
      }
  }
}

/**
 * Split the buffer into visual lines for rendering. Returns one entry
 * per logical newline; the caller may further wrap by visible width.
 */
export function splitLines(text: string): string[] {
  return text.split('\n')
}

/**
 * Locate the cursor's (line index, column index) within the buffer.
 * Both indices are zero-based.
 */
export function cursorLineCol(text: string, cursor: number): { line: number; col: number } {
  const before = text.slice(0, cursor)
  const lines = before.split('\n')
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length }
}
