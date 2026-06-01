// Split a rendered message body into text / link runs so the message pane can
// style links: every link gets a subtle marker (underline + link colour) and
// the one the per-message focus ring currently points at gets the strong
// full-background treatment — the in-conversation analogue of the focused
// chat row's highlight bar.
//
// The body is already flattened to a single string by htmlToText, where links
// appear either bare (`https://x`) or annotated (`label (https://x)`). Rather
// than thread structured spans through htmlToText (it normalises whitespace
// across the whole string), we locate URLs in the finished text. The matched
// URL is what carries the styling; the surrounding label stays plain.

import { unwrapSafeLink } from '../text/links'

export type BodySpanKind = 'text' | 'link' | 'link-focused'
export type BodySpan = { text: string; kind: BodySpanKind }

// http(s) and mailto runs. Stops at whitespace or a closing paren so the
// trailing `)` of an annotated `label (href)` isn't swallowed into the link.
const URL_RE = /(?:https?:\/\/|mailto:)[^\s)]+/gi

export function splitBodyLinkSpans(text: string, focusedHref?: string | null): BodySpan[] {
  if (!text) return []
  const focused = focusedHref ? unwrapSafeLink(focusedHref) : null
  const spans: BodySpan[] = []
  let last = 0
  URL_RE.lastIndex = 0
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    const url = m[0]
    if (m.index > last) spans.push({ text: text.slice(last, m.index), kind: 'text' })
    const isFocused = focused != null && unwrapSafeLink(url) === focused
    spans.push({ text: url, kind: isFocused ? 'link-focused' : 'link' })
    last = m.index + url.length
  }
  if (last < text.length) spans.push({ text: text.slice(last), kind: 'text' })
  return spans
}
