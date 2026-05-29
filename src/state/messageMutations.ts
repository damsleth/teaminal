// Pure, optimistic mutations over a conversation's message list.
//
// These mirror the write-path actions (react / edit / delete) locally so
// the UI updates the instant the user acts, before the Graph round-trip
// confirms. Each returns a new array (or the same reference when the target
// message isn't present) and never mutates its input — the action layer
// snapshots the prior array and restores it on failure.
//
// Pure module: no Graph, no store, no Ink. Lives in state/ alongside the
// poller's merge reducer for the same reason.

import type { ChatMessage, IdentityUser, Reaction } from '../types'

// The reaction type the given user has currently set on this message, if
// any. Used to make the reaction key a toggle (press the same reaction to
// remove it) and to gate unsetReaction calls.
export function ownReactionType(message: ChatMessage, userId: string): string | null {
  for (const r of message.reactions ?? []) {
    if (r.user?.user?.id === userId) return r.reactionType
  }
  return null
}

function mapMessage(
  messages: ChatMessage[],
  messageId: string,
  fn: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  let changed = false
  const next = messages.map((m) => {
    if (m.id !== messageId) return m
    changed = true
    return fn(m)
  })
  return changed ? next : messages
}

// Add `user`'s reaction of `reactionType`, replacing any reaction the same
// user previously had on the message (Teams allows one reaction per user).
export function applyReaction(
  messages: ChatMessage[],
  messageId: string,
  reactionType: string,
  user: IdentityUser,
): ChatMessage[] {
  return mapMessage(messages, messageId, (m) => {
    const others = (m.reactions ?? []).filter((r) => r.user?.user?.id !== user.id)
    const reaction: Reaction = {
      reactionType,
      createdDateTime: undefined,
      user: { user },
    }
    return { ...m, reactions: [...others, reaction] }
  })
}

// Remove `user`'s reaction (of any type) from the message.
export function removeReaction(
  messages: ChatMessage[],
  messageId: string,
  userId: string,
): ChatMessage[] {
  return mapMessage(messages, messageId, (m) => {
    const reactions = (m.reactions ?? []).filter((r) => r.user?.user?.id !== userId)
    return { ...m, reactions }
  })
}

// Replace a message body with edited content. Bumps lastModifiedDateTime so
// the existing "(edited)" marker shows immediately (past the 5s grace).
export function applyEdit(
  messages: ChatMessage[],
  messageId: string,
  content: string,
  modifiedDateTime: string,
): ChatMessage[] {
  return mapMessage(messages, messageId, (m) => ({
    ...m,
    body: { contentType: 'text', content },
    lastModifiedDateTime: modifiedDateTime,
  }))
}

// Mark a message deleted (tombstone). The MessagePane renders deletedDateTime
// as a "(message deleted …)" placeholder.
export function applyDelete(
  messages: ChatMessage[],
  messageId: string,
  deletedDateTime: string,
): ChatMessage[] {
  return mapMessage(messages, messageId, (m) => ({ ...m, deletedDateTime }))
}
