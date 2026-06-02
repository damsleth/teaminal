// Channel thread reconstruction from the flat chatsvc stream.
//
// The chatsvc channel reader returns the full conversation stream - roots
// and replies interleaved (ordered by sequenceId). A message is a thread
// ROOT when it has no reply linkage; replies carry replyToId pointing at
// their root (derived in the chatsvc normalizer from rootMessageId, or
// parentmessageid in tenants that send it). Teams channels are 2-level, so
// replyToId IS the root id - we group on it directly.
//
// Grouping locally means reply counts and per-root reply lists come for free
// from the one stream we already fetched: no Graph /replies door (FOCI-walled)
// and no N+1 per-root fetch.

import type { ChatMessage } from '../types'

// A channel message is a thread root when it carries no reply linkage.
export function isChannelRoot(m: ChatMessage): boolean {
  return !m.replyToId
}

// Thread roots only, in stream order. Used by the channel timeline view and
// its cursor index space (replies are reached via the thread view, not the
// flat list).
export function channelRoots(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(isChannelRoot)
}

export type ChannelThreads = {
  /** Thread roots, in stream order. */
  roots: ChatMessage[]
  /** rootId -> its replies, in stream order. */
  repliesByRoot: Record<string, ChatMessage[]>
}

// Split a flat channel stream into roots + a rootId->replies map. A reply
// whose root is outside the loaded window still clusters under its rootId,
// so the thread is reconstructable as more pages load.
export function groupChannelThreads(messages: ChatMessage[]): ChannelThreads {
  const roots: ChatMessage[] = []
  const repliesByRoot: Record<string, ChatMessage[]> = {}
  for (const m of messages) {
    if (m.replyToId) {
      ;(repliesByRoot[m.replyToId] ??= []).push(m)
    } else {
      roots.push(m)
    }
  }
  return { roots, repliesByRoot }
}

export function replyCountForRoot(threads: ChannelThreads, rootId: string): number {
  return threads.repliesByRoot[rootId]?.length ?? 0
}
