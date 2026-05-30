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

// All reaction types the given user has currently set on this message.
// Teams allows multiple distinct reactions per user per message.
export function ownReactionTypes(message: ChatMessage, userId: string): string[] {
  return (message.reactions ?? [])
    .filter((r) => r.user?.user?.id === userId)
    .map((r) => r.reactionType)
}

// True when the user already has a reaction of the exact given type.
export function hasReactionType(message: ChatMessage, userId: string, type: string): boolean {
  return (message.reactions ?? []).some(
    (r) => r.user?.user?.id === userId && r.reactionType === type,
  )
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

// Add `user`'s reaction of `reactionType` additively — does NOT remove the
// user's other-type reactions. Guard against duplicates: if the user already
// has that exact type this is a no-op so the reactions array is stable.
export function applyReaction(
  messages: ChatMessage[],
  messageId: string,
  reactionType: string,
  user: IdentityUser,
): ChatMessage[] {
  return mapMessage(messages, messageId, (m) => {
    // No-op if the user already has this exact type.
    if (hasReactionType(m, user.id, reactionType)) return m
    const reaction: Reaction = {
      reactionType,
      createdDateTime: undefined,
      user: { user },
    }
    return { ...m, reactions: [...(m.reactions ?? []), reaction] }
  })
}

// Remove ONLY the (user, type) pair from the message, leaving the user's
// other-type reactions intact.
export function removeReactionType(
  messages: ChatMessage[],
  messageId: string,
  userId: string,
  type: string,
): ChatMessage[] {
  return mapMessage(messages, messageId, (m) => {
    const reactions = (m.reactions ?? []).filter(
      (r) => !(r.user?.user?.id === userId && r.reactionType === type),
    )
    return { ...m, reactions }
  })
}

// Remove `user`'s reactions of ALL types from the message.
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
