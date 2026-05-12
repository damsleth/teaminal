// Teams HTML message body -> plain text suitable for one-line terminal rendering.
//
// Uses htmlparser2 + entities rather than a regex stack because Teams
// messages routinely contain nested formatting and the regex approach
// loses too much (e.g. <at> mentions wrap inner text we want to keep,
// <emoji> uses an alt attribute we want to extract, &amp;-style
// entities need decoding).
//
// Output rules:
//   - <p>, <br>             -> line break, collapsed to a space for the
//                              MessagePane one-row layout (callers can
//                              keep newlines when they want multi-line)
//   - <strong>/<b>/<em>/<i>
//     <u>/<s>/<strike>      -> drop tag, keep inner text as-is
//   - <a href="...">text</a>-> "text (href)" when href differs from the
//                              displayed text, otherwise just text
//   - <at id="N">name</at>  -> "@name" so mentions visually stand out
//   - <emoji alt="🎉" .../>-> the alt attribute (Teams emoji unicode)
//   - everything else        -> dropped
//
// `htmlparser2` does HTML entity decoding when `decodeEntities: true` is set;
// we leave it on since Teams content is HTML, not XML.

import { Parser } from 'htmlparser2'

const TEXT_KEEP_TAGS = new Set([
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'strike',
  'span',
  'div',
  'pre',
  'code',
  'blockquote',
  'ul',
  'ol',
  'li',
])

type ParseState = {
  out: string[]
  // <a href="...">: capture inner text into aText then emit on close.
  aDepth: number
  aHref: string | null
  aText: string
  // <at>: capture inner text into atText then emit on close (with @ prefix).
  atDepth: number
  atText: string
  // Whether we're inside any tag we should silently drop (other than
  // explicitly handled / TEXT_KEEP_TAGS).
  dropDepth: number
}

function newState(): ParseState {
  return {
    out: [],
    aDepth: 0,
    aHref: null,
    aText: '',
    atDepth: 0,
    atText: '',
    dropDepth: 0,
  }
}

function appendText(s: ParseState, text: string): void {
  if (s.dropDepth > 0) return
  if (s.aDepth > 0) {
    s.aText += text
    return
  }
  if (s.atDepth > 0) {
    s.atText += text
    return
  }
  s.out.push(text)
}

export type HtmlToTextOpts = {
  // Keep newlines in the output. Defaults to false (collapse to spaces),
  // which matches the MessagePane one-row layout. Set true if a future
  // multi-line view wants real breaks.
  preserveNewlines?: boolean
  // Append the URL after the link text in parens when href differs from
  // the displayed text. Defaults to true.
  showLinkUrl?: boolean
}

export function htmlToText(html: string, opts?: HtmlToTextOpts): string {
  if (!html) return ''
  const showLinkUrl = opts?.showLinkUrl ?? true
  const state = newState()

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const lower = name.toLowerCase()
        if (lower === 'br') {
          appendText(state, '\n')
          return
        }
        if (lower === 'p') {
          // Insert a line break before the paragraph contents if we already
          // have output, so adjacent <p>...</p> don't run together.
          if (state.out.length > 0) appendText(state, '\n')
          return
        }
        if (lower === 'a') {
          state.aDepth++
          if (state.aDepth === 1) {
            state.aHref = attrs.href ?? null
            state.aText = ''
          }
          return
        }
        if (lower === 'at') {
          state.atDepth++
          if (state.atDepth === 1) state.atText = ''
          return
        }
        if (lower === 'emoji') {
          const alt = attrs.alt ?? ''
          if (alt) appendText(state, alt)
          // emoji is treated as self-closing; if it has children we still
          // want to ignore them - bump dropDepth so any nested text is
          // discarded.
          state.dropDepth++
          return
        }
        if (TEXT_KEEP_TAGS.has(lower)) {
          // pass through; inner text appended via ontext
          return
        }
        // Unknown tag: drop until matching close.
        state.dropDepth++
      },
      ontext(text) {
        appendText(state, text)
      },
      onclosetag(name) {
        const lower = name.toLowerCase()
        if (lower === 'br' || lower === 'p') {
          if (lower === 'p') appendText(state, '\n')
          return
        }
        if (lower === 'a') {
          if (state.aDepth === 1) {
            const display = state.aText.trim()
            const href = state.aHref ?? ''
            const annotated =
              showLinkUrl && href && display && href !== display
                ? `${display} (${href})`
                : display || href
            // We drained aText into the buffer manually; push what we synthesized.
            // Push directly to out (we're at top level when this fires).
            state.out.push(annotated)
            state.aHref = null
            state.aText = ''
          }
          state.aDepth = Math.max(0, state.aDepth - 1)
          return
        }
        if (lower === 'at') {
          if (state.atDepth === 1) {
            const inner = state.atText.trim()
            state.out.push(inner ? `@${inner}` : '@')
            state.atText = ''
          }
          state.atDepth = Math.max(0, state.atDepth - 1)
          return
        }
        if (lower === 'emoji') {
          state.dropDepth = Math.max(0, state.dropDepth - 1)
          return
        }
        if (TEXT_KEEP_TAGS.has(lower)) return
        // Unknown tag closing: matching open bumped dropDepth, so pop it.
        state.dropDepth = Math.max(0, state.dropDepth - 1)
      },
    },
    { decodeEntities: true },
  )

  parser.write(html)
  parser.end()

  const joined = state.out.join('')
  if (opts?.preserveNewlines) {
    return joined
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim()
  }
  return joined.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}
