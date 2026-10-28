// Teams HTML message body -> text, either as styled runs (RichSpan[], for the
// message pane) or flattened to a string (previews, notifications, search).
//
// Uses htmlparser2 + entities rather than a regex stack because Teams
// messages routinely contain nested formatting and the regex approach
// loses too much (e.g. <at> mentions wrap inner text we want to keep,
// <emoji> uses an alt attribute we want to extract, &amp;-style
// entities need decoding).
//
// Output rules (HTML whitespace semantics: text-node whitespace collapses
// to one space, except inside <pre>/<codeblock>):
//   - <br>                  -> line break
//   - <p>, <div>, <h1-6>,
//     <pre>, <codeblock>,
//     <blockquote>, <li>    -> block: starts and ends on its own line
//   - <li>                  -> "• " or "N. ", indented by list depth
//   - <blockquote>          -> "│ " before each line
//   - <strong>/<b>, <em>/<i>,
//     <u>, <s>/<strike>/<del>,
//     <code>, <pre>         -> styled run (bold/italic/underline/strike/code)
//   - <a href="...">text</a>-> "text (href)" when href differs from the
//                              displayed text, otherwise just text
//   - <at id="N">name</at>  -> "@name" so mentions visually stand out
//   - <emoji alt="🎉" .../>-> the alt attribute (Teams emoji unicode)
//   - everything else        -> dropped
//
// htmlToText collapses the result to one line unless preserveNewlines is set.
//
// `htmlparser2` does HTML entity decoding when `decodeEntities: true` is set;
// we leave it on since Teams content is HTML, not XML.

import { Parser } from 'htmlparser2'

// True when a string is composed only of emoji (pictographs plus their
// component code points: skin-tone modifiers, ZWJ sequences, variation
// selectors, keycap combiner) and whitespace, with at least one pictograph.
// Teams' chatsvc HTML renders emoji as `<img alt="😕">` rather than the
// Graph `<emoji>` element; this lets us treat such an <img> as text (its
// alt) instead of a fetchable hosted-content image. Requiring a pictograph
// keeps plain alt text ("bilde", "123", "Media") from matching, since
// \p{Emoji_Component} alone includes ASCII digits.
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣\s]+$/u
const HAS_PICTOGRAPH_RE = /\p{Extended_Pictographic}/u

export function isEmojiOnly(value: string | null | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (!HAS_PICTOGRAPH_RE.test(trimmed)) return false
  return EMOJI_ONLY_RE.test(trimmed)
}

export type RichSpan = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
}

type Style = Omit<RichSpan, 'text'>
type StyleKey = keyof Style

const STYLE_KEYS: StyleKey[] = ['bold', 'italic', 'underline', 'strike', 'code']

const STYLE_TAGS: Record<string, StyleKey> = {
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  code: 'code',
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const BLOCK_TAGS = new Set(['p', 'div', ...HEADING_TAGS])
const PRE_TAGS = new Set(['pre', 'codeblock'])
// Pass-through containers: no effect of their own, inner text kept.
const TEXT_KEEP_TAGS = new Set(['span'])

export type HtmlToTextOpts = {
  // Keep line breaks in the output. Defaults to false (collapse to one
  // line), for previews and notifications.
  preserveNewlines?: boolean
  // Append the URL after the link text in parens when href differs from
  // the displayed text. Defaults to true.
  showLinkUrl?: boolean
}

export function richText(spans: RichSpan[]): string {
  return spans.map((s) => s.text).join('')
}

function sameStyle(a: Style, b: Style): boolean {
  return STYLE_KEYS.every((k) => !!a[k] === !!b[k])
}

export function htmlToRich(html: string, opts?: HtmlToTextOpts): RichSpan[] {
  if (!html) return []
  const showLinkUrl = opts?.showLinkUrl ?? true
  const spans: RichSpan[] = []
  const style: Record<StyleKey, number> = { bold: 0, italic: 0, underline: 0, strike: 0, code: 0 }
  const lists: { ordered: boolean; n: number }[] = []
  let preDepth = 0
  let quoteDepth = 0
  // <a> / <at>: capture inner text, emit on close.
  let aDepth = 0
  let aHref: string | null = null
  let aText = ''
  let atDepth = 0
  let atText = ''
  // Inside a tag we drop wholesale (unknown tags, <emoji> children).
  let dropDepth = 0

  const tail = (): string => {
    for (let i = spans.length - 1; i >= 0; i--) {
      const t = spans[i]!.text
      if (t) return t
    }
    return ''
  }
  const atLineStart = (): boolean => {
    const t = tail()
    return t === '' || t.endsWith('\n')
  }
  const currentStyle = (): Style => {
    const out: Style = {}
    for (const k of STYLE_KEYS) if (style[k] > 0) out[k] = true
    return out
  }
  const push = (text: string, st: Style = currentStyle()): void => {
    if (!text) return
    const last = spans[spans.length - 1]
    if (last && sameStyle(last, st)) {
      last.text += text
      return
    }
    spans.push({ text, ...st })
  }
  const linePrefix = (): void => {
    if (quoteDepth > 0) push('│ '.repeat(quoteDepth), {})
  }
  const newline = (): void => {
    // Drop trailing spaces on the line being closed.
    const last = spans[spans.length - 1]
    if (last && preDepth === 0) last.text = last.text.replace(/ +$/, '')
    // At most one blank line in a row.
    if (tail().endsWith('\n\n')) return
    push('\n', {})
  }
  const ensureNewline = (): void => {
    if (!atLineStart()) newline()
  }
  const emit = (raw: string): void => {
    if (dropDepth > 0) return
    if (aDepth > 0) {
      aText += raw
      return
    }
    if (atDepth > 0) {
      atText += raw
      return
    }
    if (preDepth > 0) {
      raw.split('\n').forEach((line, i) => {
        if (i > 0) push('\n', {})
        if (line && atLineStart()) linePrefix()
        push(line)
      })
      return
    }
    // Collapse HTML whitespace; &nbsp; (U+00A0) survives as a real space.
    let text = raw.replace(/[ \t\r\n\f]+/g, ' ')
    if (atLineStart()) text = text.replace(/^ +/, '')
    else if (tail().endsWith(' ')) text = text.replace(/^ /, '')
    if (!text) return
    if (atLineStart()) linePrefix()
    push(text)
  }

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const lower = name.toLowerCase()
        if (dropDepth > 0) {
          // <br>/<img> are void: they never close, so don't count them.
          if (lower !== 'br' && lower !== 'img') dropDepth++
          return
        }
        if (lower === 'br') {
          if (aDepth > 0) aText += ' '
          else if (atDepth === 0) newline()
          return
        }
        if (BLOCK_TAGS.has(lower)) {
          ensureNewline()
          if (HEADING_TAGS.has(lower)) style.bold++
          return
        }
        if (PRE_TAGS.has(lower)) {
          ensureNewline()
          preDepth++
          style.code++
          return
        }
        if (lower === 'blockquote') {
          ensureNewline()
          quoteDepth++
          return
        }
        if (lower === 'ul' || lower === 'ol') {
          ensureNewline()
          lists.push({ ordered: lower === 'ol', n: 0 })
          return
        }
        if (lower === 'li') {
          ensureNewline()
          const list = lists[lists.length - 1]
          const bullet = list?.ordered ? `${++list.n}. ` : '• '
          linePrefix()
          push('  '.repeat(Math.max(0, lists.length - 1)) + bullet, {})
          return
        }
        const styleKey = STYLE_TAGS[lower]
        if (styleKey) {
          style[styleKey]++
          return
        }
        if (lower === 'a') {
          aDepth++
          if (aDepth === 1) {
            aHref = attrs.href ?? null
            aText = ''
          }
          return
        }
        if (lower === 'at') {
          atDepth++
          if (atDepth === 1) atText = ''
          return
        }
        if (lower === 'emoji') {
          const alt = attrs.alt ?? ''
          if (alt) emit(alt)
          // Treated as self-closing; drop any nested text.
          dropDepth++
          return
        }
        if (lower === 'img') {
          // Teams chatsvc renders emoji as <img alt="😕"> (Graph uses
          // <emoji>). Surface the alt as text for emoji-only images; real
          // images are dropped here and shown via the separate [img] row.
          if (isEmojiOnly(attrs.alt)) emit(attrs.alt!)
          return
        }
        if (TEXT_KEEP_TAGS.has(lower)) return
        // Unknown tag: drop until matching close.
        dropDepth++
      },
      ontext(text) {
        emit(text)
      },
      onclosetag(name) {
        const lower = name.toLowerCase()
        if (lower === 'br' || lower === 'img') return
        if (dropDepth > 0) {
          dropDepth--
          return
        }
        if (BLOCK_TAGS.has(lower)) {
          if (HEADING_TAGS.has(lower)) style.bold = Math.max(0, style.bold - 1)
          ensureNewline()
          return
        }
        if (PRE_TAGS.has(lower)) {
          preDepth = Math.max(0, preDepth - 1)
          style.code = Math.max(0, style.code - 1)
          ensureNewline()
          return
        }
        if (lower === 'blockquote') {
          ensureNewline()
          quoteDepth = Math.max(0, quoteDepth - 1)
          return
        }
        if (lower === 'ul' || lower === 'ol') {
          lists.pop()
          ensureNewline()
          return
        }
        if (lower === 'li') {
          ensureNewline()
          return
        }
        const styleKey = STYLE_TAGS[lower]
        if (styleKey) {
          style[styleKey] = Math.max(0, style[styleKey] - 1)
          return
        }
        if (lower === 'a') {
          if (aDepth === 1) {
            const display = aText.replace(/\s+/g, ' ').trim()
            const href = aHref ?? ''
            const annotated =
              showLinkUrl && href && display && href !== display
                ? `${display} (${href})`
                : display || href
            aDepth = 0
            aHref = null
            aText = ''
            emit(annotated)
            return
          }
          aDepth = Math.max(0, aDepth - 1)
          return
        }
        if (lower === 'at') {
          if (atDepth === 1) {
            const inner = atText.replace(/\s+/g, ' ').trim()
            atDepth = 0
            atText = ''
            emit(inner ? `@${inner}` : '@')
            return
          }
          atDepth = Math.max(0, atDepth - 1)
        }
      },
    },
    { decodeEntities: true },
  )

  parser.write(html)
  parser.end()
  return trimSpans(spans)
}

// Trim leading / trailing whitespace (newlines and nbsp included) off the
// whole run list, dropping runs that end up empty.
function trimSpans(spans: RichSpan[]): RichSpan[] {
  while (spans.length > 0) {
    const first = spans[0]!
    first.text = first.text.replace(/^\s+/, '')
    if (first.text) break
    spans.shift()
  }
  while (spans.length > 0) {
    const last = spans[spans.length - 1]!
    last.text = last.text.replace(/\s+$/, '')
    if (last.text) break
    spans.pop()
  }
  return spans
}

// Outgoing message body. Single-line text goes as plain text (unchanged
// from before); multi-line text goes as escaped HTML with <br> so Teams
// keeps the line breaks.
export function teamsMessageBody(text: string): { contentType: 'text' | 'html'; content: string } {
  if (!text.includes('\n')) return { contentType: 'text', content: text }
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return { contentType: 'html', content: escaped.replace(/\n/g, '<br>') }
}

export function htmlToText(html: string, opts?: HtmlToTextOpts): string {
  const text = richText(htmlToRich(html, opts))
  if (opts?.preserveNewlines) return text
  return text.replace(/\s+/g, ' ').trim()
}
