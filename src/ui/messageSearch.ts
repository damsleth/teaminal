// In-conversation message search.
//
// Pure reducer + step utilities for the S1 in-pane filter described in
// .plans/search.md. Operates on the array of messages currently in the
// store; no Graph cost.
//
// Matching: case-insensitive substring against a normalized version of
// the message body. Sender display name is included so a user can
// type 'mike deploy' and find it. We compute a 'haystack' string per
// message once and reuse it across results to keep the per-keystroke
// cost low even for long histories.

import type { ChatMessage } from '../types'
import { htmlToText } from '../text/html'

export type SearchHit = {
  /** Index into the original messages array. */
  index: number
  /** ID of the matched message; useful for stable keys / cursor sync. */
  id: string
}

function haystack(m: ChatMessage): string {
  const sender = m.from?.user?.displayName ?? ''
  const raw = m.body.content ?? ''
  const text = m.body.contentType === 'text' ? raw : htmlToText(raw)
  return `${sender}\n${text}`.toLowerCase()
}

export function searchMessages(messages: ChatMessage[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (haystack(m).includes(q)) {
      hits.push({ index: i, id: m.id })
    }
  }
  return hits
}

/**
 * Step `current` to the nearest hit in `direction`. direction === 1 is
 * 'newer' (later in the array); -1 is 'older'. Wraps around. Returns
 * null when there are no hits at all.
 */
export function stepHit(
  hits: SearchHit[],
  current: number | null,
  direction: 1 | -1,
): number | null {
  if (hits.length === 0) return null
  if (current === null) {
    return direction === 1 ? hits[0]!.index : hits[hits.length - 1]!.index
  }
  // Find the index of the current hit; if not found, snap to nearest by
  // index distance.
  let pos = hits.findIndex((h) => h.index === current)
  if (pos === -1) {
    if (direction === 1) {
      pos = hits.findIndex((h) => h.index > current)
      if (pos === -1) pos = 0
    } else {
      const idx = [...hits].reverse().findIndex((h) => h.index < current)
      pos = idx === -1 ? hits.length - 1 : hits.length - 1 - idx
    }
    return hits[pos]!.index
  }
  const next = (pos + direction + hits.length) % hits.length
  return hits[next]!.index
}

/** Most recent hit (largest index), or null when no hits. */
export function newestHitIndex(hits: SearchHit[]): number | null {
  if (hits.length === 0) return null
  return hits[hits.length - 1]!.index
}
