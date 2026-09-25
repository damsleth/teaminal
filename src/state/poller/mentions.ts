// Mention detection helper. Strict id-based matching only — short
// display names ("Carl", "Nina") false-positive on unrelated text, so
// we never use textual fallback. See AGENTS.md "Known Pitfalls" #6.

import type { ChatMessage, ChatType } from '../../types'

/**
 * True iff `msg` should fire a mention notification for the user
 * identified by `myUserId`. Excludes own echoes; requires a structured
 * mention with `mentioned.user.id === myUserId`.
 */
export function shouldNotifyMention(msg: ChatMessage, myUserId: string): boolean {
  if (msg.from?.user?.id === myUserId) return false // own echo
  const mentions = msg.mentions
  if (!mentions || mentions.length === 0) return false
  return mentions.some((m) => m.mentioned?.user?.id === myUserId)
}

export type NotifyKind = 'mention' | 'message'

/**
 * Why (if at all) `msg` should notify. Mentions always win; a plain
 * message notifies only in 1:1/group chats (meeting chats and channels
 * are too noisy) and only when `notifyChatMessages` is on. System
 * events, deleted messages and own echoes never notify.
 */
export function notifyKind(
  msg: ChatMessage,
  myUserId: string,
  chatType: ChatType | undefined,
  notifyChatMessages: boolean,
): NotifyKind | null {
  if (shouldNotifyMention(msg, myUserId)) return 'mention'
  if (!notifyChatMessages) return null
  if (chatType !== 'oneOnOne' && chatType !== 'group') return null
  if (!msg.from?.user || msg.from.user.id === myUserId) return null
  if (msg.messageType && msg.messageType !== 'message') return null
  if (msg.deletedDateTime) return null
  return 'message'
}
