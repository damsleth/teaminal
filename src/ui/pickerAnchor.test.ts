import { describe, expect, test } from 'bun:test'
import { pickerAnchorCol, wrapText } from './pickerAnchor'

// ──────────────────────────────────────────────────────────────
// wrapText
// ──────────────────────────────────────────────────────────────
describe('wrapText', () => {
  test('empty string returns single empty line', () => {
    expect(wrapText('', 80)).toEqual([''])
  })

  test('short text that fits on one line', () => {
    expect(wrapText('hello', 80)).toEqual(['hello'])
  })

  test('text wraps at column boundary', () => {
    // 'abcde fghij' with width=5 should split on the space: ['abcde', 'fghij']
    // but since 'abcde' is already 5 wide, ' ' would exceed it → wrap before ' '
    // Actually: 'abcde' = 5, then space would make 6 → wrap. ' fghij' starts new
    // line. Let's use a simpler test:
    const lines = wrapText('abcdefghij', 5)
    expect(lines).toEqual(['abcde', 'fghij'])
  })

  test('multi-line wrap where last line is shorter', () => {
    // 15 chars wrapped at 10 → ['0123456789', '01234']
    const lines = wrapText('012345678901234', 10)
    expect(lines).toEqual(['0123456789', '01234'])
    expect(lines[lines.length - 1]).toBe('01234')
  })

  test('preserves explicit newlines', () => {
    const lines = wrapText('hello\nworld', 80)
    expect(lines).toEqual(['hello', 'world'])
  })

  test('wide emoji counts as 2 columns', () => {
    // '😀' is 2 columns wide. With width=3, two emoji = 4 > 3, so they split.
    const lines = wrapText('😀😀', 3)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]).toBe('😀')
  })
})

// ──────────────────────────────────────────────────────────────
// pickerAnchorCol
// ──────────────────────────────────────────────────────────────
describe('pickerAnchorCol', () => {
  const fallback = 33 // e.g. listPaneWidth(30) + 3

  test('empty body returns fallback', () => {
    expect(
      pickerAnchorCol({
        bodyText: '',
        bodyStartCol: 50,
        messageTextColumns: 40,
        fallbackCol: fallback,
        terminalColumns: 120,
      }),
    ).toBe(fallback)
  })

  test('whitespace-only body returns fallback', () => {
    expect(
      pickerAnchorCol({
        bodyText: '   ',
        bodyStartCol: 50,
        messageTextColumns: 40,
        fallbackCol: fallback,
        terminalColumns: 120,
      }),
    ).toBe(fallback)
  })

  test('single short line: col = bodyStartCol + text width', () => {
    // bodyText = 'hello' (5 chars), bodyStartCol = 50 → endCol = 55
    expect(
      pickerAnchorCol({
        bodyText: 'hello',
        bodyStartCol: 50,
        messageTextColumns: 40,
        fallbackCol: fallback,
        terminalColumns: 120,
      }),
    ).toBe(55)
  })

  test('multi-line wrap: uses last (short) line width', () => {
    // 'abcdefghijklmno' (15 chars) wrapped at 10 → last line is 'opqrstu...' ...
    // Let's do 'aaaaaaaaaa bbbbb' with wrapWidth=10:
    // Line 1: 'aaaaaaaaaa' (10), Line 2: ' bbbbb' → actually...
    // Use deterministic text: 15 'a's wrapped at 10 → lines ['aaaaaaaaaa','aaaaa']
    // bodyStartCol=50, last line width=5, endCol=55
    expect(
      pickerAnchorCol({
        bodyText: 'aaaaaaaaaaaaaaa', // 15 a's
        bodyStartCol: 50,
        messageTextColumns: 10,
        fallbackCol: fallback,
        terminalColumns: 120,
      }),
    ).toBe(55) // 50 + 5
  })

  test('wide-char line: emoji contributes 2 columns each', () => {
    // '😀😀' = 4 display cols, bodyStartCol = 50 → endCol = 54
    expect(
      pickerAnchorCol({
        bodyText: '😀😀',
        bodyStartCol: 50,
        messageTextColumns: 40,
        fallbackCol: fallback,
        terminalColumns: 120,
      }),
    ).toBe(54)
  })

  test('clamps to terminalColumns - 1', () => {
    // Very long single-line body that would exceed terminal width
    const longBody = 'x'.repeat(200)
    const result = pickerAnchorCol({
      bodyText: longBody,
      bodyStartCol: 50,
      messageTextColumns: 300, // no wrap
      fallbackCol: fallback,
      terminalColumns: 120,
    })
    expect(result).toBe(119) // clamped to 120-1
  })

  test('clamping uses max(1, terminalColumns - 1) so minimum is 1', () => {
    const result = pickerAnchorCol({
      bodyText: 'hi',
      bodyStartCol: 1,
      messageTextColumns: 80,
      fallbackCol: fallback,
      terminalColumns: 1, // edge case
    })
    // clamped: min(3, max(1, 1-1)) = min(3, 1) = 1
    expect(result).toBe(1)
  })
})
