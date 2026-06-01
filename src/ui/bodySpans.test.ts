import { describe, expect, test } from 'bun:test'
import { splitBodyLinkSpans } from './bodySpans'

describe('splitBodyLinkSpans', () => {
  test('returns a single text span when there are no links', () => {
    expect(splitBodyLinkSpans('just a plain message')).toEqual([
      { text: 'just a plain message', kind: 'text' },
    ])
  })

  test('empty input yields no spans', () => {
    expect(splitBodyLinkSpans('')).toEqual([])
  })

  test('splits a bare url out of surrounding text', () => {
    expect(splitBodyLinkSpans('see https://example.com now')).toEqual([
      { text: 'see ', kind: 'text' },
      { text: 'https://example.com', kind: 'link' },
      { text: ' now', kind: 'text' },
    ])
  })

  test('does not swallow the closing paren of an annotated link', () => {
    expect(splitBodyLinkSpans('docs (https://example.com/a)')).toEqual([
      { text: 'docs (', kind: 'text' },
      { text: 'https://example.com/a', kind: 'link' },
      { text: ')', kind: 'text' },
    ])
  })

  test('marks mailto links', () => {
    const spans = splitBodyLinkSpans('mail me at mailto:a@b.no')
    expect(spans[1]).toEqual({ text: 'mailto:a@b.no', kind: 'link' })
  })

  test('handles multiple links', () => {
    const spans = splitBodyLinkSpans('a https://x.io b https://y.io')
    expect(spans.filter((s) => s.kind === 'link').map((s) => s.text)).toEqual([
      'https://x.io',
      'https://y.io',
    ])
  })

  test('marks the focused link strong, leaving the others subtle', () => {
    const spans = splitBodyLinkSpans('a https://x.io b https://y.io', 'https://y.io')
    expect(spans.find((s) => s.text === 'https://x.io')?.kind).toBe('link')
    expect(spans.find((s) => s.text === 'https://y.io')?.kind).toBe('link-focused')
  })

  test('correlates the focused link through a Safe-Links wrapper', () => {
    const safe =
      'https://eu.safelinks.protection.outlook.com/?url=https%3A%2F%2Fy.io%2Fp&data=1'
    const spans = splitBodyLinkSpans(`go ${safe}`, 'https://y.io/p')
    expect(spans.find((s) => s.kind === 'link-focused')?.text).toBe(safe)
  })
})
