import type { ChatMessage } from '../types'
import { describeSystemEvent } from './systemEvent'

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
