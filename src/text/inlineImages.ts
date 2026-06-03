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
import { isEmojiOnly } from './html'

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
  // Raw asm/asyncgw object id (e.g. "0-wch-d2-..."), when derivable from the
  // <img itemid>, an asm.skype.com object URL, or a base64 hostedContents id.
  // Lets the image cache retrieve via asyncgw on Conditional-Access-gated
  // (ic3) accounts where the Graph hostedContents endpoint 401s.
  objectId?: string
  // Teams object-store region (`emea`, `amer`, `apac`, `ind`) when derivable
  // from an asm.skype.com / asyncgw URL or encoded hostedContents id.
  region?: string
  // Browser-openable URL when it differs from sourcePath. Set for SharePoint
  // file uploads, where sourcePath is a Graph /shares path but the original
  // contentUrl is what a browser (with its own auth) can open — the only
  // route for cross-tenant federated chats, where the Graph fetch 403s.
  openUrl?: string
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

// A raw asm/asyncgw object id, e.g. "0-wch-d2-eb96...". Teams puts this on
// image bodies as <img itemid="..."> and embeds it in both asm.skype.com
// object URLs and (base64-encoded) Graph hostedContents ids.
const ASM_OBJECT_ID_RE = /^[0-9]+-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/i

function objectIdFromObjectsUrl(value: string): string | null {
  const m = value.match(/\/objects\/([^/?#,\s"]+)(?:\/views\/|\b)/)
  return m ? decodeURIComponent(m[1]!) : null
}

function decodeHostedContentId(id: string): string | null {
  if (!/^[A-Za-z0-9_+/=-]{16,}$/.test(id)) return null
  try {
    return Buffer.from(id, 'base64').toString('utf8')
  } catch {
    return null
  }
}

// hostedContents ids are base64 of e.g.
//   "id=,type=1,url=https://eu-api.asm.skype.com/v1/objects/0-.../views/imgo"
// Decode and mine the embedded object id. Returns null on any other shape.
function objectIdFromHostedContentId(id: string): string | null {
  const decoded = decodeHostedContentId(id)
  if (!decoded) return null
  if (!decoded.includes('objects/')) return null
  return objectIdFromObjectsUrl(decoded)
}

// Best-effort raw object id for asyncgw retrieval, from any of the shapes
// Teams uses to reference a hosted image.
function asmObjectId(itemid: string | null, src: string | null): string | undefined {
  if (itemid && ASM_OBJECT_ID_RE.test(itemid)) return itemid
  if (src && /\/objects\//.test(src)) {
    const id = objectIdFromObjectsUrl(src)
    if (id) return id
  }
  for (const cand of [hostedContentIdFromUrl(src ?? ''), itemid, src]) {
    if (!cand) continue
    const id = objectIdFromHostedContentId(cand)
    if (id) return id
  }
  return undefined
}

function asyncGwRegionFromPrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined
  const map: Record<string, string> = {
    eu: 'emea',
    emea: 'emea',
    na: 'amer',
    amer: 'amer',
    ap: 'apac',
    apac: 'apac',
    in: 'ind',
    ind: 'ind',
  }
  return map[prefix.toLowerCase()]
}

function regionFromObjectStoreUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (host.endsWith('.asyncgw.teams.microsoft.com')) {
    return asyncGwRegionFromPrefix(host.match(/^([a-z]+)-prod\.asyncgw\./)?.[1])
  }
  if (host.endsWith('asm.skype.com')) {
    return asyncGwRegionFromPrefix(host.match(/^([a-z]+)[-.]/)?.[1])
  }
  return undefined
}

function regionFromHostedContentId(id: string): string | undefined {
  const decoded = decodeHostedContentId(id)
  if (!decoded || !decoded.includes('objects/')) return undefined
  const url = decoded.match(/https:\/\/[^,\s"]*\/objects\/[^,\s"]+/)?.[0]
  return regionFromObjectStoreUrl(url)
}

function asmObjectRegion(itemid: string | null, src: string | null): string | undefined {
  const direct = regionFromObjectStoreUrl(src)
  if (direct) return direct
  for (const cand of [hostedContentIdFromUrl(src ?? ''), itemid, src]) {
    if (!cand) continue
    const region = regionFromHostedContentId(cand)
    if (region) return region
  }
  return undefined
}

// A raw asyncgw object URL. Kept local (rather than imported from the graph
// client) so this stays a pure text module.
function isAsyncGwUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return /^https:\/\/[a-z-]+\.asyncgw\.teams\.microsoft\.com\//i.test(url)
}

// asm.skype.com object URLs need the asyncgw session auth, like asyncgw URLs
// themselves — they must not go through the plain external-fetch path.
function isObjectStoreUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return isAsyncGwUrl(url) || /^https:\/\/[^/]*asm\.skype\.com\//i.test(url)
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

// File uploads (contentType "reference") live in the uploader's OneDrive;
// their contentUrl is a SharePoint document URL that 403s without auth, so
// it must never go through the plain external-fetch path.
function isSharePointUrl(url: string | null | undefined): boolean {
  if (!url) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return host.endsWith('.sharepoint.com')
}

// Graph shares-API path for a SharePoint document URL: base64url-encode the
// URL into a "u!" share id (the Graph "encoded sharing URL" format). The
// /content segment 302-redirects to a pre-authenticated download URL, which
// fetch() follows.
function sharesGraphPath(url: string): string {
  const b64 = Buffer.from(url, 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')
  return `/shares/u!${b64}/driveItem/content`
}

function attachmentSourcePath(
  a: MessageAttachment,
  chatId: string,
  messageId: string,
): {
  path: string
  isExternal: boolean
  openUrl?: string
} {
  const url = a.contentUrl ?? ''
  if (isSharePointUrl(url)) {
    // Uploaded file in the sender's OneDrive. Fetch via the Graph shares
    // API (the unauthenticated external fetch 403s); keep the original URL
    // so open-in-browser still works when the Graph fetch can't (the
    // cross-tenant federated case).
    return { path: sharesGraphPath(url), isExternal: false, openUrl: url }
  }
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
    const { path, isExternal, openUrl } = attachmentSourcePath(att, chatId, messageId)
    const objectId = asmObjectId(att.id, att.contentUrl ?? null)
    const region = asmObjectRegion(att.id, att.contentUrl ?? null)
    const cacheKey = `${messageId}::${att.id}`
    if (seen.has(cacheKey)) continue
    seen.add(cacheKey)
    const nameUrl = openUrl ?? (isExternal ? path : null)
    const name =
      att.name && att.name.length > 0 ? att.name : nameUrl ? inferNameFromUrl(nameUrl) : 'image'
    out.push({
      cacheKey,
      sourcePath: path,
      isExternal,
      name,
      contentType: att.contentType,
      ...(objectId ? { objectId } : {}),
      ...(region ? { region } : {}),
      ...(openUrl ? { openUrl } : {}),
    })
  }

  // 2. body <img> tags - pasted inline images, frequently with empty attachments.
  const body = message.body?.content ?? ''
  for (const img of parseBodyImages(body)) {
    // Teams chatsvc renders emoji as <img alt="😕"> rather than the Graph
    // <emoji> element. Those aren't hosted-content images — htmlToText emits
    // their alt as text — so never try to fetch them (it 400s/401s, and on
    // chatsvc messages chatId is empty, producing /chats//messages/...).
    if (isEmojiOnly(img.alt)) continue
    const objectId = asmObjectId(img.itemid, img.src)
    const region = asmObjectRegion(img.itemid, img.src)
    // Prefer the id embedded in a Graph $value src URL: it's the
    // authoritative hostedContents id. In cross-tenant 1:1 chats itemid is
    // the raw asm object id (e.g. "0-nch-d3-..."), which the Graph endpoint
    // 404s on, while the src carries the real (base64) id. Fall back to
    // itemid for bodies without a Graph src.
    let contentId = img.src ? hostedContentIdFromUrl(img.src) : null
    if (!contentId) contentId = img.itemid
    if (!contentId) {
      if (img.src && isObjectStoreUrl(img.src)) {
        // asm.skype.com / asyncgw object URL embedded directly in the body.
        // Both need the asyncgw session auth: raw asyncgw URLs go through the
        // existing asyncgw-URL path (isExternal), asm URLs via the objectId.
        const cacheKey = `${messageId}::${objectId ?? img.src}`
        if (seen.has(cacheKey)) continue
        seen.add(cacheKey)
        out.push({
          cacheKey,
          sourcePath: img.src,
          isExternal: isAsyncGwUrl(img.src),
          name: img.alt || inferNameFromUrl(img.src),
          contentType: '',
          ...(objectId ? { objectId } : {}),
          ...(region ? { region } : {}),
        })
        continue
      }
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
    // The Graph hostedContents fetch needs the chat id. chatsvc-sourced
    // messages don't carry one — fall back to asyncgw-by-objectId when we
    // have it, else skip rather than build /chats//messages/... (400).
    if (!chatId && !objectId) continue
    const cacheKey = `${messageId}::${contentId}`
    if (seen.has(cacheKey)) continue
    seen.add(cacheKey)
    const sourcePath = chatId
      ? `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/hostedContents/${encodeURIComponent(contentId)}/$value`
      : ''
    out.push({
      cacheKey,
      sourcePath,
      isExternal: false,
      name: img.alt || 'image',
      contentType: '',
      ...(objectId ? { objectId } : {}),
      ...(region ? { region } : {}),
    })
  }

  return out
}
