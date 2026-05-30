// Pure message-merge helpers used by the active loop and the load-older
// path. No store, no fetch — just chronological merging that preserves
// optimistic-send messages.

import type { ChatMessage } from '../../types'

function messageTime(msg: ChatMessage): number {
  const parsed = Date.parse(msg.createdDateTime)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Merge two messages that share the same id. The incoming (server) copy is
 * authoritative for all fields EXCEPT reactions, where we apply a
 * reaction-preservation rule to survive the server propagation window:
 *
 *   - Incoming has reactions  → use them (server is authoritative; this
 *     handles both "reaction confirmed" and "last reaction removed server-side").
 *   - Incoming lacks reactions (key absent or empty []) AND existing has
 *     reactions → preserve existing reactions. This keeps an optimistic
 *     reaction visible during the window between the user reacting and the
 *     server propagating the change back in the next poll response.
 *   - Both lack reactions → no reactions on the merged message (steady-state
 *     for unreacted messages, or after the last reaction is genuinely removed
 *     on both sides).
 *
 * The rule is safe for load-older merges too: an older fetched page carries
 * whatever reactions the server returned at fetch time; if the existing cache
 * has since received fresher reactions, we keep them rather than regressing
 * to the older snapshot. Since load-older pages are always older than the
 * existing head, the incoming reactions are always staler there anyway.
 */
function mergeMessageReactions(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  const incomingReactions = incoming.reactions
  const hasIncomingReactions = Array.isArray(incomingReactions) && incomingReactions.length > 0
  if (hasIncomingReactions) {
    // Server has reactions — use them as-is.
    return incoming
  }
  const existingReactions = existing.reactions
  const hasExistingReactions = Array.isArray(existingReactions) && existingReactions.length > 0
  if (hasExistingReactions) {
    // Server returned no reactions but the in-memory copy has some — preserve
    // them on the merged message. This covers the propagation-window race where
    // the optimistic reaction has not yet appeared in the server response.
    return { ...incoming, reactions: existingReactions }
  }
  // Neither side has reactions; return the server copy unchanged.
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
