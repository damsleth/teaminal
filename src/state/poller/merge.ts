// Pure message-merge helpers used by the active loop and the load-older
// path. No store, no fetch — just chronological merging that preserves
// optimistic-send messages.

import type { ChatMessage } from '../../types'

function messageTime(msg: ChatMessage): number {
  const parsed = Date.parse(msg.createdDateTime)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Merge two message lists by id, sorted ascending by createdDateTime.
 * Server-confirmed messages take precedence wherever ids overlap.
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
  for (const msg of incoming) byId.set(msg.id, msg)
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
