import type { ChatMessage } from '../types'
import { parseMessageReference } from '../types'
import { describeSystemEvent } from './systemEvent'
import { htmlToText } from '../text/html'
import { shortName } from '../state/selectables'

const QUOTED_REPLY_PREVIEW_MAX = 60

// True when a message is worth rendering. The user has explicitly asked
// for no meaningless "(system)" rows, so the gate is: every kept row
// must either have a real sender name we can show, OR be a decodable
// system event that we'll render in place of the sender column. Empty
// or undecodable system rows are dropped entirely.
export function isRenderableMessage(m: ChatMessage): boolean {
  if (m.deletedDateTime) {
    // Tombstone deletes always have a "deleted by ..." preview that
    // is useful regardless of sender, so keep them.
    return true
  }
  if (m.messageType === 'systemEventMessage') {
    return describeSystemEvent(m) !== null
  }
  if (effectiveSenderName(m) === null) return false
  const hasBody =
    typeof m.body?.content === 'string' && m.body.content.replace(/<[^>]+>/g, '').trim().length > 0
  return hasBody
}

export function messagesForTimelineNavigation(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => isRenderableMessage(m))
}

// Best display name we can produce for a non-system message, or null
// if there's no name to show. Falls through user → application →
// device. (Graph returns app/bot messages with from.application set
// and from.user null; under some FOCI tokens it sets neither.)
export function effectiveSenderName(m: ChatMessage): string | null {
  const direct = m.from?.user?.displayName?.trim()
  if (direct) return direct
  const app = m.from?.application?.displayName?.trim()
  if (app) return app
  const device = m.from?.device?.displayName?.trim()
  if (device) return device
  return null
}

// Returns the quoted-reply preview for a chat message (1:1 / group),
// or null when the message is not a reply.
//
// Graph attaches a messageReference attachment to the new message and
// inlines an opaque <attachment id="..."> tag at the top of body.content;
// the reference's `content` JSON carries the quoted message's sender,
// preview, and timestamp. We surface a one-line "↳ replying to X: '...'"
// row above the new message body so users see what's being responded to
// without leaving the chat view.
//
// Falls back to null on malformed JSON (Graph occasionally ships an
// attachment with valid contentType but unparsable content) so callers
// can render the body unchanged. Channel thread replies are not
// considered here — the existing thread tree already represents them.
export function getQuotedReply(
  m: ChatMessage,
): { senderName: string; preview: string } | null {
  const attachments = m.attachments ?? []
  for (const a of attachments) {
    const ref = parseMessageReference(a)
    if (!ref) continue
    const senderRaw = ref.messageSender?.user?.displayName?.trim() ?? ''
    const senderName = senderRaw ? shortName(senderRaw) : '?'
    const preview = trimQuotedPreview(ref.messagePreview ?? '')
    return { senderName, preview }
  }
  return null
}

function trimQuotedPreview(raw: string): string {
  if (!raw) return ''
  // Preview may carry HTML (mentions, links). Strip to plain text and
  // collapse to a single line.
  const plain = htmlToText(raw).replace(/\s+/g, ' ').trim()
  if (plain.length <= QUOTED_REPLY_PREVIEW_MAX) return plain
  return plain.slice(0, QUOTED_REPLY_PREVIEW_MAX - 1) + '…'
}
