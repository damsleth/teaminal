// Mention detection helper. Strict id-based matching only — short
// display names ("Carl", "Nina") false-positive on unrelated text, so
// we never use textual fallback. See AGENTS.md "Known Pitfalls" #6.

import type { ChatMessage } from '../../types'

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
