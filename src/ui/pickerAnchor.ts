// Pure helper: compute the terminal column at the END of the focused
// message body's last wrapped line, so the system emoji picker anchors
// to the trailing edge of the message text rather than the far left of
// the message pane.
//
// All inputs are cell-column counts (1-indexed terminal columns start
// at 1; this helper works in 0-based widths and the callers convert).
//
// Best-effort: wide-char / emoji widths are approximated via string-width
// when the package is available; the function never throws.

import stringWidth from 'string-width'

/**
 * Wrap `text` to `columns` display-width columns and return the resulting
 * lines. Each line is guaranteed to be at most `columns` display cells wide.
 * An empty string returns `['']`.
 */
export function wrapText(text: string, columns: number): string[] {
  const width = Math.max(1, columns)
  if (!text) return ['']

  const lines: string[] = []
  // Split on explicit newlines first, then wrap each paragraph.
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }
    // Walk grapheme clusters, accumulating until we hit the column limit.
    const segments = [...new Intl.Segmenter().segment(paragraph)].map((s) => s.segment)
    let current = ''
    let currentWidth = 0
    for (const seg of segments) {
      const segW = stringWidth(seg)
      if (currentWidth > 0 && currentWidth + segW > width) {
        lines.push(current)
        current = seg
        currentWidth = segW
      } else {
        current += seg
        currentWidth += segW
      }
    }
    lines.push(current)
  }
  return lines.length > 0 ? lines : ['']
}

/**
 * Return the 1-based terminal column just AFTER the last character of the
 * focused message body's last wrapped line.
 *
 * @param bodyText   - The rendered body text (same string the MessageRow
 *                     Text element receives — from previewBody()).
 * @param bodyStartCol - 1-based terminal column where the body text starts
 *                       (= messageBodyTerminalColumn output).
 * @param messageTextColumns - The wrap width used for the body Text element.
 * @param fallbackCol - Column to return when the body is empty or computation
 *                      fails (typically `listPaneWidth + 3`, the existing
 *                      left-anchored value).
 * @param terminalColumns - Terminal width; the result is clamped to this - 1.
 */
export function pickerAnchorCol(opts: {
  bodyText: string
  bodyStartCol: number
  messageTextColumns: number
  fallbackCol: number
  terminalColumns: number
}): number {
  const { bodyText, bodyStartCol, messageTextColumns, fallbackCol, terminalColumns } = opts
  try {
    const trimmed = bodyText.trim()
    if (!trimmed) return fallbackCol

    const lines = wrapText(trimmed, messageTextColumns)
    const lastLine = lines[lines.length - 1] ?? ''
    const lastLineWidth = stringWidth(lastLine)

    // 1-based col = body start + display width of last line
    const col = bodyStartCol + lastLineWidth
    return Math.min(col, Math.max(1, terminalColumns - 1))
  } catch {
    return fallbackCol
  }
}
