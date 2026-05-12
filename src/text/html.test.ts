import { describe, expect, test } from 'bun:test'
import { htmlToText } from './html'

describe('htmlToText', () => {
  test('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('')
  })

  test('passes plain text through with whitespace normalized', () => {
    expect(htmlToText('hello   world')).toBe('hello world')
  })

  test('strips simple <p> wrappers', () => {
    expect(htmlToText('<p>hello</p>')).toBe('hello')
  })

  test('joins multiple paragraphs with a single space (default)', () => {
    expect(htmlToText('<p>a</p><p>b</p>')).toBe('a b')
  })

  test('preserves paragraph breaks when preserveNewlines is true', () => {
    expect(htmlToText('<p>a</p><p>b</p>', { preserveNewlines: true })).toBe('a\n\nb')
  })

  test('treats <br> as a line break (collapsed to space by default)', () => {
    expect(htmlToText('a<br>b')).toBe('a b')
    expect(htmlToText('a<br>b', { preserveNewlines: true })).toBe('a\nb')
  })

  test('keeps inner text of strong/em/b/i tags', () => {
    expect(htmlToText('<strong>bold</strong> and <em>italic</em>')).toBe('bold and italic')
    expect(htmlToText('<b>x</b><i>y</i>')).toBe('xy')
  })

  test('keeps inner text of formatting tags including u/s/code', () => {
    expect(htmlToText('<u>x</u> <s>y</s> <code>z</code>')).toBe('x y z')
  })

  test('decodes HTML entities', () => {
    expect(htmlToText('a &amp; b &lt;c&gt; &quot;d&quot;')).toBe('a & b <c> "d"')
    expect(htmlToText('&nbsp;hi&nbsp;')).toBe('hi')
  })

  test('renders <at> mention with @ prefix', () => {
    expect(htmlToText('<at id="0">Carl Joakim</at>')).toBe('@Carl Joakim')
  })

  test('renders <at> with no inner text as a bare @', () => {
    expect(htmlToText('<at id="0"></at>')).toBe('@')
  })

  test('extracts emoji alt attribute', () => {
    expect(htmlToText('<emoji id="celebration" alt="🎉" type="basic"></emoji>')).toBe('🎉')
    expect(htmlToText('hi <emoji alt="😀"></emoji> there')).toBe('hi 😀 there')
  })

  test('renders an anchor without URL when href matches inner text', () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe(
      'https://example.com',
    )
  })

  test('annotates anchor with URL when it differs from inner text', () => {
    expect(htmlToText('<a href="https://example.com">click here</a>')).toBe(
      'click here (https://example.com)',
    )
  })

  test('honors showLinkUrl=false to suppress URL annotation', () => {
    expect(htmlToText('<a href="https://example.com">click</a>', { showLinkUrl: false })).toBe(
      'click',
    )
  })

  test('falls back to href when anchor has no inner text', () => {
    expect(htmlToText('<a href="https://example.com"></a>')).toBe('https://example.com')
  })

  test('strips unknown tags entirely (script tags lose content)', () => {
    expect(htmlToText('keep <script>alert(1)</script> me')).toBe('keep me')
  })

  test('strips remote image references', () => {
    expect(htmlToText('photo: <img src="https://example.com/img.png" alt="cat"/>')).toBe('photo:')
  })

  test('combines mentions, emoji, and anchors in one body', () => {
    const html =
      '<p><at id="0">Carl</at> see <a href="https://example.com">this</a> ' +
      '<emoji alt="✨"></emoji></p>'
    expect(htmlToText(html)).toBe('@Carl see this (https://example.com) ✨')
  })

  test('handles uppercase tag names', () => {
    expect(htmlToText('<P><STRONG>HI</STRONG></P>')).toBe('HI')
  })

  test('handles nested formatting without leaking tags', () => {
    expect(htmlToText('<p><strong><em>x</em></strong></p>')).toBe('x')
  })

  test('handles malformed HTML by best effort', () => {
    // unclosed tags - htmlparser2 closes them at end of input. Plain
    // `<strong>` carries no separator, so adjacent text concatenates.
    expect(htmlToText('<p>a<strong>b')).toBe('ab')
  })

  test('skips system event placeholder', () => {
    // System messages come through with this exact body sometimes;
    // it's not a real tag so we just see it as text. The MessagePane has
    // a separate branch for systemEventMessage, so this is just a sanity
    // check that we don't crash on the literal.
    expect(htmlToText('<systemEventMessage/>')).toBe('')
  })
})
