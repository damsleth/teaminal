// One-shot diagnostic logger for the inline-image extraction work.
// Gated by TEAMINAL_DEBUG at the call site; this module assumes the
// gate has already passed.
//
// Logs the raw shape of each new message that contains either an
// `<img>` tag in body.content or an attachments[] entry, so we can
// see exactly what Graph returns for the three image flavors (pasted
// inline, uploaded, gif-picker) without baking signed URLs into the
// log file. contentUrl is redacted down to its host.

import { recordEvent } from '../../log'
import type { ChatMessage, MessageAttachment } from '../../types'

function hostOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return '(unparsable)'
  }
}

function extractBodyImgRefs(html: string | undefined): Array<{
  itemid: string | null
  hasSrc: boolean
  srcHost: string
}> {
  if (!html) return []
  const out: Array<{ itemid: string | null; hasSrc: boolean; srcHost: string }> = []
  const tagRe = /<img\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0]
    const itemid = /\bitemid="([^"]+)"/i.exec(tag)?.[1] ?? null
    const src = /\bsrc="([^"]+)"/i.exec(tag)?.[1] ?? null
    out.push({ itemid, hasSrc: !!src, srcHost: hostOf(src) })
  }
  return out
}

function summarizeAttachment(a: MessageAttachment): Record<string, unknown> {
  return {
    id: a.id,
    contentType: a.contentType,
    name: a.name ?? null,
    contentUrlHost: hostOf(a.contentUrl ?? ''),
  }
}

export function logMessageImageShape(message: ChatMessage): void {
  const bodyImgs = extractBodyImgRefs(message.body?.content)
  const atts = message.attachments ?? []
  if (bodyImgs.length === 0 && atts.length === 0) return
  const payload = JSON.stringify({
    messageId: message.id,
    chatId: message.chatId ?? null,
    bodyContentType: message.body?.contentType,
    bodyImgs,
    attachments: atts.map(summarizeAttachment),
  })
  recordEvent('graph', 'debug', `message image shape ${payload}`)
}
