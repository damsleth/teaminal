// Activity feed reducer + selectors.
//
// CSA can deliver the same activity twice: once via the initial /updates
// hydrate, once via a trouter push that reconciles it locally. Dedup by
// id is therefore non-negotiable. unreadMentionCount is recomputed from
// the merged list rather than tracked separately, so a stale count can't
// drift from the visible list.

import { getActiveProfile } from '../graph/client'
import { listActivityFeed, type ActivityItem } from '../graph/teamsActivity'
import { recordEvent } from '../log'
import type { AppState, Store } from './store'

const ACTIVITY_FEED_CAP = 200

export function mergeActivityItems(
  current: ActivityItem[],
  incoming: ActivityItem[],
): ActivityItem[] {
  if (incoming.length === 0) return current
  const byId = new Map<string, ActivityItem>()
  // Incoming first so the server-fresh shape wins on conflicts; then
  // fill in the older entries the server didn't re-send this page.
  for (const item of incoming) byId.set(item.id, item)
  for (const item of current) {
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  const merged = [...byId.values()]
  merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return merged.slice(0, ACTIVITY_FEED_CAP)
}

export function countUnreadMentions(items: ActivityItem[]): number {
  let n = 0
  for (const item of items) {
    if (!item.isRead && (item.kind === 'mention' || item.kind === 'reply')) n++
  }
  return n
}

// State-layer wrapper around listActivityFeed. UI components can call
// this to trigger an on-demand refresh (e.g. when the activity modal
// opens) without violating the ui → graph layering rule. Always
// best-effort: a failure is logged and the cached feed remains.
//
// `isStale` lets callers cancel the store write if the session was torn
// down (profile switch) while the fetch was in flight — otherwise the
// resolved page would repopulate the new account's wiped feed with the
// old account's items.
export async function refreshActivityFeed(
  store: Store<AppState>,
  isStale?: () => boolean,
): Promise<void> {
  const requestProfile = getActiveProfile()
  try {
    const page = await listActivityFeed({
      profile: requestProfile,
      syncState: store.get().activitySyncState,
    })
    // Drop the result if the session/profile changed under us.
    if (isStale?.() || getActiveProfile() !== requestProfile) return
    if (page.items.length === 0 && !page.syncState) return
    store.set((s) => {
      const merged = mergeActivityItems(s.activityFeed, page.items)
      return {
        activityFeed: merged,
        unreadMentionCount: countUnreadMentions(merged),
        activitySyncState: page.syncState ?? s.activitySyncState,
      }
    })
  } catch (err) {
    recordEvent(
      'graph',
      'debug',
      `activity refresh skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function markActivityRead(items: ActivityItem[], ids: string[] | 'all'): ActivityItem[] {
  if (items.length === 0) return items
  const targets: Set<string> | null = ids === 'all' ? null : new Set(ids)
  let mutated = false
  const next = items.map((item) => {
    if (item.isRead) return item
    if (!targets || targets.has(item.id)) {
      mutated = true
      return { ...item, isRead: true }
    }
    return item
  })
  return mutated ? next : items
}
