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
 */
export function findExistingOneOnOne(
  chats: Chat[],
  otherUserId: string,
  selfUserId: string,
): Chat | null {
  for (const chat of chats) {
    if (chat.chatType !== 'oneOnOne') continue
    const members = chat.members ?? []
    const hasSelf = members.some((m) => m.userId === selfUserId)
    const hasOther = members.some((m) => m.userId === otherUserId)
    if (hasSelf && hasOther) return chat
  }
  return null
}
