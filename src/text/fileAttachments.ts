// Pull non-image, non-reference file attachments out of a chat message.
//
// Teams routes file/voice attachments through several shapes:
//   - `contentType: 'reference'` with a SharePoint / OneDrive contentUrl
//   - `contentType: 'audio/aac'` (voice messages) — typically AsyncGW
//   - `contentType: 'application/octet-stream'` or a concrete MIME for
//     direct file uploads
// We surface anything that isImageAttachment() rejects AND isn't a
// quoted-message reference attachment, so the user sees that the
// message carries a file even if we can't render it inline.
//
// Pure module: no Ink, no Graph client.

import { isImageAttachment, type ChatMessage, type MessageAttachment } from '../types'

export type FileAttachmentRef = {
  id: string
  /** Best-known display name. Falls back to a generic label. */
  name: string
  /** MIME from Graph, or empty string when not provided. */
  contentType: string
  /** The URL Teams hands us. Caller decides how to fetch (asyncgw vs Graph). */
  sourceUrl: string
  /** Best-effort size in bytes; missing when Graph didn't send size info. */
  sizeBytes?: number
}

const SKIPPED_CONTENT_TYPES = new Set([
  'messageReference',
  'application/vnd.microsoft.card.codesnippet',
  'application/vnd.microsoft.card.adaptive',
])

function looksLikeImage(a: MessageAttachment): boolean {
  if (isImageAttachment(a)) return true
  if (a.contentType.startsWith('image/')) return true
  return false
}

function sizeFromContent(content: string | null | undefined): number | undefined {
  if (!content) return undefined
  try {
    const obj = JSON.parse(content) as { fileSize?: unknown; size?: unknown }
    const raw = obj.fileSize ?? obj.size
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string') {
      const n = Number(raw)
      if (Number.isFinite(n)) return n
    }
  } catch {
    // not JSON; ignore
  }
  return undefined
}

export function extractFileAttachments(message: ChatMessage): FileAttachmentRef[] {
  const out: FileAttachmentRef[] = []
  for (const att of message.attachments ?? []) {
    if (SKIPPED_CONTENT_TYPES.has(att.contentType)) continue
    if (looksLikeImage(att)) continue
    const url = att.contentUrl ?? ''
    if (!url) continue
    const name = att.name && att.name.length > 0 ? att.name : nameFromUrl(url) || 'attachment'
    const ref: FileAttachmentRef = {
      id: att.id,
      name,
      contentType: att.contentType,
      sourceUrl: url,
    }
    const size = sizeFromContent(att.content)
    if (size !== undefined) ref.sizeBytes = size
    out.push(ref)
  }
  return out
}

function nameFromUrl(url: string): string | undefined {
  const clean = url.split(/[?#]/)[0] ?? ''
  const lastSlash = clean.lastIndexOf('/')
  if (lastSlash < 0) return undefined
  const tail = clean.slice(lastSlash + 1)
  return tail.length > 0 ? decodeURIComponent(tail) : undefined
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}
