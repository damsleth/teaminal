// Pure message-merge helpers used by the active loop and the load-older
// path. No store, no fetch — just chronological merging that preserves
// optimistic-send messages.

import type { ChatMessage, Reaction } from '../../types'

function messageTime(msg: ChatMessage): number {
  const parsed = Date.parse(msg.createdDateTime)
  return Number.isFinite(parsed) ? parsed : 0
}

// How long a local reaction change survives polls that return no reactions:
// the server propagation window. After it, the server copy wins, so a
// reaction removed on another client clears here too.
export const REACTION_PENDING_MS = 30_000

/**
 * Merge two messages that share the same id. The incoming (server) copy is
 * authoritative, except that a local reaction change made within
 * REACTION_PENDING_MS keeps its reactions while the server still returns none.
 */
function mergeMessageReactions(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  if ((incoming.reactions?.length ?? 0) > 0) return incoming
  const pendingAt = existing._reactionsPendingAt
  if (
    (existing.reactions?.length ?? 0) > 0 &&
    pendingAt !== undefined &&
    Date.now() - pendingAt < REACTION_PENDING_MS
  ) {
    return { ...incoming, reactions: existing.reactions, _reactionsPendingAt: pendingAt }
  }
  return incoming
}

/**
 * Merge two message lists by id, sorted ascending by createdDateTime.
 * Server-confirmed messages take precedence wherever ids overlap, with the
 * exception of reactions (see mergeMessageReactions above).
 *
 * This is the workhorse merge used by both the active-poll merge (where
 * `existing` may carry optimistic _sending / _sendError messages we do
 * not want to drop) and load-older (where `existing` is the cached
 * head and `incoming` is an older page).
 */
export function mergeChronological(
  existing: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const msg of existing) byId.set(msg.id, msg)
  // A server copy carrying a send identity replaces the local row with the
  // same identity under another id (the optimistic temp row, or a send result
  // whose id came back as the client id): one logical message, one row.
  const echoed = new Set(incoming.map((m) => m.clientMessageId).filter(Boolean))
  if (echoed.size > 0) {
    const incomingIds = new Set(incoming.map((m) => m.id))
    for (const msg of existing) {
      if (msg.clientMessageId && echoed.has(msg.clientMessageId) && !incomingIds.has(msg.id)) {
        byId.delete(msg.id)
      }
    }
  }
  for (const msg of incoming) {
    const prev = byId.get(msg.id)
    byId.set(msg.id, prev !== undefined ? mergeMessageReactions(prev, msg) : msg)
  }
  return Array.from(byId.values()).sort((a, b) => messageTime(a) - messageTime(b))
}

/**
 * Convenience alias used by the active loop. Identical semantics to
 * `mergeChronological`; the name documents the call site's intent.
 */
export function mergeWithOptimistic(existing: ChatMessage[], server: ChatMessage[]): ChatMessage[] {
  return mergeChronological(existing, server)
}

/** Count messages in `incoming` whose ids are not present in `existing`. */
export function countNewMessages(existing: ChatMessage[], incoming: ChatMessage[]): number {
  const ids = new Set(existing.map((m) => m.id))
  let count = 0
  for (const msg of incoming) {
    if (!ids.has(msg.id)) count++
  }
  return count
}

/** Newest message id in a chronologically-sorted list, or undefined. */
export function newestMessageId(messages: ChatMessage[]): string | undefined {
  return messages[messages.length - 1]?.id
}

// ---------------------------------------------------------------------------
// Render-equivalence checks
//
// mergeChronological always allocates a fresh array, and the messages inside
// it are the freshly-parsed server objects, so a poll that returns identical
// data still produces new references everywhere. Store.set compares by
// reference, so that woke every useAppState subscriber and re-reconciled the
// whole message pane on a 5s timer for no reason.
//
// These helpers let the caller detect "nothing the UI shows actually changed"
// and keep the previous references, following the same identity-preserving
// pattern as indexNamesFromMessages.
// ---------------------------------------------------------------------------

function sameReactions(a: Reaction[] | undefined, b: Reaction[] | undefined): boolean {
  const al = a?.length ?? 0
  const bl = b?.length ?? 0
  if (al !== bl) return false
  if (al === 0) return true
  for (let i = 0; i < al; i++) {
    const x = a?.[i]
    const y = b?.[i]
    if (x?.reactionType !== y?.reactionType) return false
    if (x?.user?.user?.id !== y?.user?.user?.id) return false
  }
  return true
}

/**
 * True when two messages are equivalent for everything the UI renders.
 *
 * Deliberately field-by-field rather than a deep compare: it must be cheap
 * enough to run on every poll, and it must not claim equality for anything
 * visible. Any field the message pane reads belongs here — if a renderer
 * starts showing a new field, add it.
 */
export function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true
  return (
    a.id === b.id &&
    a.createdDateTime === b.createdDateTime &&
    a.lastModifiedDateTime === b.lastModifiedDateTime &&
    a.deletedDateTime === b.deletedDateTime &&
    a.messageType === b.messageType &&
    a.subject === b.subject &&
    a.importance === b.importance &&
    a.replyToId === b.replyToId &&
    a.rootMessageId === b.rootMessageId &&
    a.sequenceId === b.sequenceId &&
    a.body.content === b.body.content &&
    a.body.contentType === b.body.contentType &&
    a.from?.user?.id === b.from?.user?.id &&
    a.from?.user?.displayName === b.from?.user?.displayName &&
    sameJson(a.attachments, b.attachments) &&
    sameJson(a.mentions, b.mentions) &&
    sameJson(a.eventDetail, b.eventDetail) &&
    a._sending === b._sending &&
    a._sendError === b._sendError &&
    a._tempId === b._tempId &&
    sameReactions(a.reactions, b.reactions)
  )
}

// Structural equality for the small nested parts of a message (attachments,
// mentions, event detail): same reference, or the same JSON.
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return (a ?? null) === (b ?? null)
  return JSON.stringify(a) === JSON.stringify(b)
}

/** True when two message lists are render-equivalent, element for element. */
export function sameMessageList(a: readonly ChatMessage[], b: readonly ChatMessage[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!x || !y || !sameMessage(x, y)) return false
  }
  return true
}
