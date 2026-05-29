// Extracts hyperlink targets from a Teams chat message body.
//
// htmlToText (src/text/html.ts) flattens <a href> into the rendered text as
// "label (href)"; this module surfaces the same links as structured units so
// they can be made individually focusable and opened in a browser.
//
// Pure module: no Ink, no Graph client, no fs. Body parsing uses htmlparser2
// (already a dep), mirroring parseBodyImages in inlineImages.ts.

import { Parser } from 'htmlparser2'
import type { ChatMessage } from '../types'

export type MessageLinkRef = {
  // The resolved target URL (Safe-Links unwrapped).
  href: string
  // Visible link text, falling back to the href when the anchor had no text.
  label: string
  // Stable per-message key: msgId::index. Used for focus identity / React keys.
  key: string
}

// Only these schemes are worth surfacing as openable links.
function isOpenableHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href)
}

// Teams rewrites external links through ATP Safe-Links
// (*.safelinks.protection.outlook.com?url=<real>&...). Unwrap to the real
// target so the displayed/opened URL is the one the user expects.
export function unwrapSafeLink(href: string): string {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return href
  }
  if (!/(^|\.)safelinks\.protection\.outlook\.com$/i.test(url.hostname)) return href
  const real = url.searchParams.get('url')
  if (!real) return href
  try {
    // Validate the unwrapped target parses; fall back to the original if not.
    new URL(real)
    return real
  } catch {
    return href
  }
}

type RawAnchor = { href: string | null; text: string }

function parseBodyAnchors(html: string): RawAnchor[] {
  if (!html || html.toLowerCase().indexOf('<a') === -1) return []
  const out: RawAnchor[] = []
  let current: RawAnchor | null = null
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name.toLowerCase() !== 'a') return
        current = { href: attrs.href ?? null, text: '' }
      },
      ontext(text) {
        if (current) current.text += text
      },
      onclosetag(name) {
        if (name.toLowerCase() !== 'a' || !current) return
        out.push(current)
        current = null
      },
    },
    { decodeEntities: true },
  )
  parser.write(html)
  parser.end()
  return out
}

export function extractMessageLinks(message: ChatMessage): MessageLinkRef[] {
  if (message.body?.contentType !== 'html') return []
  const html = message.body.content ?? ''
  const seen = new Set<string>()
  const out: MessageLinkRef[] = []
  for (const anchor of parseBodyAnchors(html)) {
    if (!anchor.href) continue
    const href = unwrapSafeLink(anchor.href.trim())
    if (!isOpenableHref(href)) continue
    if (seen.has(href)) continue
    seen.add(href)
    const label = anchor.text.replace(/\s+/g, ' ').trim() || href
    out.push({ href, label, key: `${message.id}::link::${out.length}` })
  }
  return out
}
