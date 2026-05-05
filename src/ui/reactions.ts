// Aggregate a message's reactions into a render-ready list.
//
// Graph returns reactions as a flat list with per-user entries; for the
// summary line we want one bucket per reactionType with a count and a
// stable ordering. The ordering used here is "insertion order of the
// type's first occurrence" so the same set of reactions on the same
// message renders the same way across renders.
//
// Custom reactions surface as a single 'custom' bucket; the displayName
// of the first occurrence is preserved as a hint for the future picker.

import type { Reaction } from '../types'

export type ReactionBucket = {
  reactionType: string
  count: number
  // Display names (first three, truncated) of the users who reacted; used
  // by the popover that opens on the focused-message reaction key.
  users: string[]
  // Custom reactions: the first-seen display name of the custom emoji.
  displayName?: string
}

export const REACTION_GLYPH: Record<string, string> = {
  like: '\ud83d\udc4d',
  heart: '\u2764\ufe0f',
  laugh: '\ud83d\ude02',
  surprised: '\ud83d\ude2e',
  sad: '\ud83d\ude22',
  angry: '\ud83d\ude20',
  custom: '\u2728',
  // Some tenants emit older or alternate types; map common aliases.
  thumbsup: '\ud83d\udc4d',
  smile: '\ud83d\ude04',
  cry: '\ud83d\ude22',
}

export function aggregateReactions(reactions: Reaction[] | undefined): ReactionBucket[] {
  if (!reactions || reactions.length === 0) return []
  const buckets = new Map<string, ReactionBucket>()
  for (const r of reactions) {
    const type = r.reactionType ?? 'unknown'
    let bucket = buckets.get(type)
    if (!bucket) {
      bucket = { reactionType: type, count: 0, users: [], displayName: r.displayName }
      buckets.set(type, bucket)
    }
    bucket.count++
    const name = r.user?.user?.displayName
    if (name && bucket.users.length < 3) bucket.users.push(name)
  }
  return Array.from(buckets.values())
}

export function reactionGlyph(type: string): string {
  return REACTION_GLYPH[type] ?? `:${type}:`
}

/**
 * Single-line summary string suitable for a Text node under the message
 * body. Returns null when there are no reactions.
 */
export function reactionsSummary(reactions: Reaction[] | undefined): string | null {
  const buckets = aggregateReactions(reactions)
  if (buckets.length === 0) return null
  return buckets.map((b) => `${reactionGlyph(b.reactionType)} ${b.count}`).join('  ')
}
