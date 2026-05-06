// Background reply-count fetcher for channel root messages.
//
// The active loop calls scheduleReplyCountFetch(...) after a channel
// page lands. The fetcher hits the replies endpoint with a small $top
// for the most recent N visible roots that don't yet have a fresh
// ThreadMeta entry. Per-channel debounce keeps the cost bounded - one
// batch per minute per channel is plenty for a "4 replies" badge.
//
// Errors are swallowed: a missing badge is fine; this loop is purely
// observational and never reports back to the user.

import { listChannelRepliesPage } from '../graph/teams'
import { debug } from '../log'
import type { ChatMessage } from '../types'
import type { AppState, Store, ThreadMeta } from './store'

const PER_CHANNEL_MIN_INTERVAL_MS = 60_000
const ROOTS_PER_BATCH = 5
const REPLIES_TOP = 50
const FRESH_WINDOW_MS = 5 * 60_000

const lastBatchByChannel = new Map<string, number>()

export function __resetThreadMetaForTests(): void {
  lastBatchByChannel.clear()
}

export function shouldRefreshThreadMeta(meta: ThreadMeta | undefined, now: number): boolean {
  if (!meta) return true
  return now - meta.checkedAt > FRESH_WINDOW_MS
}

export function selectRootsToCheck(
  rootMessages: ChatMessage[],
  threadMetaByRoot: Record<string, ThreadMeta>,
  now: number,
  limit = ROOTS_PER_BATCH,
): string[] {
  const out: string[] = []
  for (const m of rootMessages) {
    if (m.replyToId) continue
    if (m.messageType === 'systemEventMessage') continue
    if (!shouldRefreshThreadMeta(threadMetaByRoot[m.id], now)) continue
    out.push(m.id)
    if (out.length >= limit) break
  }
  return out
}

export type ReplyFetcher = (
  teamId: string,
  channelId: string,
  rootId: string,
) => Promise<{ messages: ChatMessage[]; nextLink?: string }>

const realFetcher: ReplyFetcher = (teamId, channelId, rootId) =>
  listChannelRepliesPage(teamId, channelId, rootId, { top: REPLIES_TOP })

let fetcher: ReplyFetcher = realFetcher

export function __setReplyFetcherForTests(f: ReplyFetcher | null): void {
  fetcher = f ?? realFetcher
}

export type ScheduleArgs = {
  store: Store<AppState>
  teamId: string
  channelId: string
  rootMessages: ChatMessage[]
  now?: number
}

/**
 * Kick off a single batch of background reply-count fetches for the
 * given channel. Returns a promise that resolves when all in-flight
 * requests have settled (mainly for tests). The active loop fires this
 * fire-and-forget.
 */
export async function scheduleReplyCountFetch(args: ScheduleArgs): Promise<void> {
  const now = args.now ?? Date.now()
  const channelKey = `${args.teamId}:${args.channelId}`
  const lastBatchAt = lastBatchByChannel.get(channelKey)
  if (lastBatchAt !== undefined && now - lastBatchAt < PER_CHANNEL_MIN_INTERVAL_MS) return
  const meta = args.store.get().threadMetaByRoot
  const rootIds = selectRootsToCheck(args.rootMessages, meta, now)
  if (rootIds.length === 0) return
  lastBatchByChannel.set(channelKey, now)

  const updates: Record<string, ThreadMeta> = {}
  await Promise.all(
    rootIds.map(async (rootId) => {
      try {
        const page = await fetcher(args.teamId, args.channelId, rootId)
        updates[rootId] = {
          count: page.messages.length,
          more: !!page.nextLink,
          checkedAt: Date.now(),
        }
      } catch (err) {
        debug(
          'threadMeta: reply-count fetch failed:',
          err instanceof Error ? err.message : String(err),
        )
      }
    }),
  )

  if (Object.keys(updates).length === 0) return
  args.store.set((s) => ({
    threadMetaByRoot: { ...s.threadMetaByRoot, ...updates },
  }))
}
