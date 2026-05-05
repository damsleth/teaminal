// Chat-list helpers used by the list loop. Pure reducers — no fetch,
// no store.

import type { Chat } from '../../types'

/**
 * /chats does not return members on the bulk list call ($expand=members
 * is capped at 25 with a different shape). Each list-poll iteration
 * would therefore overwrite previously-hydrated members with undefined
 * and chat labels would flip back to "(1:1)". Carry forward members
 * from the prior store snapshot so labels stay stable.
 */
export function mergeChatMembers(prev: Chat[], next: Chat[]): Chat[] {
  if (prev.length === 0) return next
  const prevById = new Map(prev.map((c) => [c.id, c]))
  return next.map((c) => {
    const p = prevById.get(c.id)
    if (p?.members && p.members.length > 0 && (!c.members || c.members.length === 0)) {
      return { ...c, members: p.members }
    }
    return c
  })
}
