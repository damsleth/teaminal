// Extracts every inline image reference from a Teams chat message.
//
// Three Graph shapes converge here:
//
//   1. Pasted inline image - `<img itemid="{contentId}">` inside body.content,
//      attachments[] is often empty. The contentId is the hostedContents key.
//   2. Uploaded image (drag-drop / paperclip) - an attachments[] entry with
//      contentType=reference (or image/*) and a Graph contentUrl. The body
//      usually has no <img> tag.
//   3. GIF from the Teams gif picker - an attachments[] entry whose
//      contentUrl points at giphy/tenor (external host) and contentType is
//      "application/vnd.microsoft.card.animation" or "image/gif". Must be
//      fetched without the Graph Authorization header.
//
// The returned list is deduped by cacheKey so a message that contains both
// a <img itemid="X"> and an attachments entry id=X renders one row.
//
// Pure module: no Ink, no Graph client, no fs. Body parsing uses
// htmlparser2 (already a dep) so we never regex-stack HTML.

import { Parser } from 'htmlparser2'
import {
  attachmentGraphPath,
  isImageAttachment,
  type ChatMessage,
  type MessageAttachment,
} from '../types'

export type InlineImageRef = {
  // Stable cache key: msgId::contentId. Used by imageCache.
  cacheKey: string
  // For Graph sources: a Graph-relative path (e.g. /chats/.../hostedContents/X/$value).
  // For external sources: the absolute external URL (e.g. https://media.giphy.com/...).
  sourcePath: string
  // True for external (giphy / tenor) hosts. Caller must fetch without the
  // Graph Authorization header.
  isExternal: boolean
  // Filename shown in the fallback `[img] name` row. Falls back to a
  // generic label when Graph gave us nothing useful.
  name: string
  // Best-known MIME. Often empty for HTML-embedded inline images.
  contentType: string
}

// Widen-by-content-type list for shapes the basic isImageAttachment misses.
// Keep narrow: only types we have concrete examples of.
const EXTRA_IMAGE_CONTENT_TYPES = new Set([
  'application/vnd.microsoft.card.animation',
  'application/vnd.microsoft.teams.card.animation',
])

const IMAGE_URL_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:\?|#|$)/i

function isExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false
  if (url.startsWith('https://graph.microsoft.com/')) return false
  if (url.startsWith('/')) return false
  return /^https?:\/\//i.test(url)
}

// Broader than isImageAttachment: also catches GIF-picker shapes that
// neither set contentType=image/* nor a sensible name.
function isImageLikeAttachment(a: MessageAttachment): boolean {
  if (isImageAttachment(a)) return true
  if (EXTRA_IMAGE_CONTENT_TYPES.has(a.contentType)) return true
  const url = a.contentUrl ?? ''
  if (IMAGE_URL_EXT.test(url)) return true
  return false
}

// Extract hostedContents id from a Graph $value URL if present.
// Returns null on any other shape.
function hostedContentIdFromUrl(url: string): string | null {
  // Match /hostedContents/{id}/$value tolerating trailing query strings.
  const m = url.match(/\/hostedContents\/([^/?#]+)\/\$value\b/)
  return m ? decodeURIComponent(m[1]!) : null
}

// Collect inline <img> references from a message body. Each entry has the
// itemid (when present) and the raw src. Self-closing or paired tags both
// fire onopentag in htmlparser2.
type BodyImageRef = { itemid: string | null; src: string | null; alt: string | null }

function parseBodyImages(html: string): BodyImageRef[] {
  if (!html || html.indexOf('<img') === -1) return []
  const out: BodyImageRef[] = []
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name.toLowerCase() !== 'img') return
        out.push({
          itemid: attrs.itemid ?? null,
          src: attrs.src ?? null,
          alt: attrs.alt ?? null,
        })
      },
    },
    { decodeEntities: true },
  )
  parser.write(html)
  parser.end()
  return out
}

function attachmentSourcePath(
  a: MessageAttachment,
  chatId: string,
  messageId: string,
): {
  path: string
  isExternal: boolean
} {
  const url = a.contentUrl ?? ''
  if (isExternalUrl(url)) {
    return { path: url, isExternal: true }
  }
  return { path: attachmentGraphPath(a, chatId, messageId), isExternal: false }
}

function inferNameFromUrl(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? ''
  const lastSlash = clean.lastIndexOf('/')
  const tail = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean
  return tail || 'image'
}

export function extractInlineImages(message: ChatMessage): InlineImageRef[] {
  const chatId = message.chatId ?? ''
  const messageId = message.id
  const seen = new Set<string>()
  const out: InlineImageRef[] = []

  // 1. attachments[] - widen for GIF picker shapes.
  for (const att of message.attachments ?? []) {
    if (!isImageLikeAttachment(att)) continue
    const { path, isExternal } = attachmentSourcePath(att, chatId, messageId)
    const cacheKey = `${messageId}::${att.id}`
    if (seen.has(cacheKey)) continue
    seen.add(cacheKey)
    const name =
      att.name && att.name.length > 0 ? att.name : isExternal ? inferNameFromUrl(path) : 'image'
    out.push({
      cacheKey,
      sourcePath: path,
      isExternal,
      name,
      contentType: att.contentType,
    })
  }

  // 2. body <img> tags - pasted inline images, frequently with empty attachments.
  const body = message.body?.content ?? ''
  for (const img of parseBodyImages(body)) {
    // Prefer itemid: it's the hostedContents id. If absent, mine the src.
    let contentId = img.itemid
    if (!contentId && img.src) {
      contentId = hostedContentIdFromUrl(img.src)
    }
    if (!contentId) {
      // Fall back: treat the raw src as the cache discriminant for external
      // images embedded directly via HTML. Rare in chat bodies, but tolerate.
      if (img.src && isExternalUrl(img.src)) {
        const cacheKey = `${messageId}::ext::${img.src}`
        if (seen.has(cacheKey)) continue
        seen.add(cacheKey)
        out.push({
          cacheKey,
          sourcePath: img.src,
          isExternal: true,
          name: img.alt || inferNameFromUrl(img.src),
          contentType: '',
        })
      }
      continue
    }
    const cacheKey = `${messageId}::${contentId}`
    if (seen.has(cacheKey)) continue
    seen.add(cacheKey)
    const sourcePath = `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/hostedContents/${encodeURIComponent(contentId)}/$value`
    out.push({
      cacheKey,
      sourcePath,
      isExternal: false,
      name: img.alt || 'image',
      contentType: '',
    })
  }

  return out
}
