// Pure helpers used by the App-level layout to derive UI state from the
// store. No store reads, no Ink imports — these are unit-testable.

import type { Chat } from '../types'

/**
 * Find an existing 1:1 chat between `selfUserId` and `otherUserId`, if
 * one is in the local chat list. Returns null when not found; the caller
 * is then expected to create a new chat.
 *
 * 1:1 chats can have any membership shape Graph chooses to give us, but
 * Teams enforces at most one 1:1 chat per pair so the linear scan here
 * is fine in practice.
 *
 * When `otherUserId === selfUserId` the caller picked their own directory
 * entry - e.g. a same-name guest identity, or themselves in another tenant.
 * That maps to the Teams "Notes to self" chat, not a peer chat. We must
 * special-case it: otherwise `hasSelf`/`hasOther` are both satisfied by the
 * single self member and the first 1:1 containing self gets returned,
 * making every same-name peer open the same (wrong) chat.
 */
export function findExistingOneOnOne(
  chats: Chat[],
  otherUserId: string,
  selfUserId: string,
): Chat | null {
  const isSelfChat = otherUserId === selfUserId
  for (const chat of chats) {
    if (chat.chatType !== 'oneOnOne') continue
    const members = chat.members ?? []
    if (isSelfChat) {
      // Notes-to-self: a 1:1 whose every hydrated member is self. Require at
      // least one member so an unhydrated chat (members: []) isn't a match.
      if (members.length > 0 && members.every((m) => m.userId === selfUserId)) return chat
      continue
    }
    const hasSelf = members.some((m) => m.userId === selfUserId)
    const hasOther = members.some((m) => m.userId === otherUserId)
    if (hasSelf && hasOther) return chat
  }
  return null
}
