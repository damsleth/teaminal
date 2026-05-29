import { describe, expect, test } from 'bun:test'
import { extractMessageLinks, unwrapSafeLink } from './links'
import type { ChatMessage } from '../types'

function htmlMessage(content: string, id = 'm1'): ChatMessage {
  return {
    id,
    createdDateTime: '2026-05-29T10:00:00Z',
    body: { contentType: 'html', content },
  } as unknown as ChatMessage
}

describe('unwrapSafeLink', () => {
  test('unwraps an ATP Safe-Links URL to its real target', () => {
    const wrapped =
      'https://nam06.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&data=x'
    expect(unwrapSafeLink(wrapped)).toBe('https://example.com/a?b=1')
  })
  test('leaves non-safelinks URLs untouched', () => {
    expect(unwrapSafeLink('https://example.com/x')).toBe('https://example.com/x')
  })
  test('returns the original when the url param is missing', () => {
    expect(unwrapSafeLink('https://safelinks.protection.outlook.com/?foo=bar')).toBe(
      'https://safelinks.protection.outlook.com/?foo=bar',
    )
  })
  test('returns the original on an unparseable URL', () => {
    expect(unwrapSafeLink('not a url')).toBe('not a url')
  })
})

describe('extractMessageLinks', () => {
  test('extracts http(s) links with their visible text', () => {
    const links = extractMessageLinks(
      htmlMessage('<p>see <a href="https://example.com/x">the docs</a></p>'),
    )
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ href: 'https://example.com/x', label: 'the docs' })
  })

  test('falls back to the href as the label when the anchor has no text', () => {
    const links = extractMessageLinks(htmlMessage('<a href="https://example.com/"></a>'))
    expect(links[0]?.label).toBe('https://example.com/')
  })

  test('unwraps Safe-Links targets', () => {
    const links = extractMessageLinks(
      htmlMessage(
        '<a href="https://x.safelinks.protection.outlook.com/?url=https%3A%2F%2Freal.example%2Fp">link</a>',
      ),
    )
    expect(links[0]?.href).toBe('https://real.example/p')
  })

  test('dedupes repeated hrefs', () => {
    const links = extractMessageLinks(
      htmlMessage('<a href="https://a.example/">a</a> <a href="https://a.example/">again</a>'),
    )
    expect(links).toHaveLength(1)
  })

  test('skips non-http(s)/mailto schemes', () => {
    const links = extractMessageLinks(
      htmlMessage('<a href="javascript:alert(1)">x</a><a href="ftp://h/f">y</a>'),
    )
    expect(links).toHaveLength(0)
  })

  test('keeps mailto links', () => {
    const links = extractMessageLinks(htmlMessage('<a href="mailto:a@b.com">mail</a>'))
    expect(links[0]?.href).toBe('mailto:a@b.com')
  })

  test('returns nothing for plain-text messages', () => {
    const msg = {
      id: 'm2',
      createdDateTime: '2026-05-29T10:00:00Z',
      body: { contentType: 'text', content: 'see https://example.com' },
    } as unknown as ChatMessage
    expect(extractMessageLinks(msg)).toEqual([])
  })
})
