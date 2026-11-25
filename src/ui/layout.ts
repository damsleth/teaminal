// Pure layout computation for chat-list width and composer height.
//
// Both values are derived from terminal dimensions and optional user
// overrides. Extracted from App.tsx so they can be unit-tested without
// rendering anything.

function clamp(v: number, lo: number, hi: number): number {
  // When hi < lo (e.g. on a very narrow terminal), bias toward lo so the
  // layout never produces a zero-width pane. The hard floor is the caller's
  // responsibility, but we handle it defensively here too.
  if (hi < lo) return lo
  return Math.max(lo, Math.min(hi, v))
}

export type LayoutInput = {
  /** Terminal width in columns. */
  cols: number
  /** Terminal height in rows. */
  rows: number
  /** Number of lines in the composer draft text. */
  draftLines: number
  /** Composer header rows above the text (reply quote, edit banner). */
  quoteRows: number
  /** Explicit chatListWidth from settings, or null for auto. */
  chatListWidth: number | null
  /** Explicit composerHeight from settings, or null for auto. */
  composerHeight: number | null
}

export type LayoutResult = {
  chatListWidth: number
  composerHeight: number
}

// Hard floor used when the terminal is so narrow that the computed hi
// bound would fall below the desired lo bound.
const CHAT_LIST_HARD_FLOOR = 12
const COMPOSER_HARD_FLOOR = 3

export function computeLayout({
  cols,
  rows,
  draftLines,
  quoteRows,
  chatListWidth,
  composerHeight,
}: LayoutInput): LayoutResult {
  // Auto chat-list width: ~28% of terminal, clamped to a readable range.
  const autoChatListWidth = clamp(Math.round(cols * 0.28), 24, 44)
  // Upper bound shrinks with narrow terminals (need >=40 cols for the pane).
  const chatListWidthHi = Math.max(CHAT_LIST_HARD_FLOOR, Math.min(60, cols - 40))
  const resolvedChatListWidth = clamp(
    chatListWidth ?? autoChatListWidth,
    CHAT_LIST_HARD_FLOOR,
    chatListWidthHi,
  )

  // Auto composer height: draft lines + borders, clamped, plus the header
  // rows (quote, edit banner) on top so they never eat into the text.
  const autoComposerHeight = clamp(draftLines + 2, 3, 8) + quoteRows
  // Upper bound keeps at least 2/3 of the terminal for the message pane. The
  // floor always fits the header rows and one text line, even when an
  // explicit setting or a short terminal asks for less.
  const floor = COMPOSER_HARD_FLOOR + quoteRows
  const composerHeightHi = Math.max(floor, Math.min(10 + quoteRows, Math.floor(rows / 3)))
  const resolvedComposerHeight = clamp(
    composerHeight ?? autoComposerHeight,
    floor,
    composerHeightHi,
  )

  return { chatListWidth: resolvedChatListWidth, composerHeight: resolvedComposerHeight }
}

// Clamp helpers re-exported so resize handlers can enforce the same bounds
// without re-implementing them.
export const CHAT_LIST_WIDTH_MIN = CHAT_LIST_HARD_FLOOR
export const CHAT_LIST_WIDTH_MAX = 60
export const COMPOSER_HEIGHT_MIN = COMPOSER_HARD_FLOOR
export const COMPOSER_HEIGHT_MAX = 10
