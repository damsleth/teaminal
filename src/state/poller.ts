// Adaptive polling loops with backoff, jitter, focus-driven cancellation,
// and seed-on-startup notification dedupe.
//
// Three independent loops run concurrently:
//
//   - active   (~10s; 60s with push connected, 5min blurred): re-fetches
//                     messages for the currently-focused chat or channel.
//                     Seeds the seen-message-ID set on first
//                     fetch (no notifications); subsequent fetches diff
//                     against the set and fire onMention for newly-seen
//                     mentions of `me` from non-self senders.
//                     Implementation: src/state/poller/activeLoop.ts
//   - list     (~30s): refreshes /chats with lastMessagePreview, joined
//                      teams, and per-team channel lists. Cross-chat
//                      mention diffing fires onMention for non-active
//                      chats whose lastMessagePreview moved.
//                      Implementation: src/state/poller/listLoop.ts
//   - presence (~60s): refreshes /me/presence and member presence for
//                      visible 1:1 chats (capped fan-out).
//                      Implementation: src/state/poller/presenceLoop.ts
//
// Each loop has its own consecutive-error counter and an exponential
// backoff capped at 60s; the next interval gets +/-20% jitter so multiple
// teaminal instances do not align.
//
// Focus change wakes the active loop's interruptable sleep and aborts any
// in-flight active fetch so opening a chat is responsive even mid-poll.
//
// Split panes: the active loop runs once per pane side (left, right), each
// polling paneFocus(state, side) with its own sleeper, abort slot and
// backoff. Without a split the right side idles. A pane switch changes
// neither side's target, so it costs no fetch.

import type { AccountStore, AccountView } from './accountStore'
import type { GraphClient } from '../graph/client'
import type { ChatMessage } from '../types'
import { recordEvent } from '../log'
import { type ConvKey, type Focus, focusKey } from './store'
import { paneFocus, visibleConvKeys, type PaneSide } from './panes'
import {
  ACTIVE_DEFAULT_MS,
  LIST_DEFAULT_MS,
  PRESENCE_DEFAULT_MS,
  adaptiveIntervalMs,
  isAbortError,
} from './poller/intervals'
import type { NotifyKind } from './poller/mentions'
import { makeSleeper, type Sleeper } from './poller/sleeper'
import { makeActiveLoop } from './poller/activeLoop'
import { makeListLoop } from './poller/listLoop'
import { makePresenceLoop } from './poller/presenceLoop'
import {
  loadOlderMessages as loadOlderMessagesImpl,
  type LoadOlderMessagesResult,
} from './poller/loadOlder'
import { mergeWithOptimistic as mergeWithOptimisticImpl } from './poller/merge'

// Re-exports preserved for callers that import these from './poller' directly.
export type { LoadOlderMessagesResult }
export { mergeChatMembers } from './poller/chatList'
export const mergeWithOptimistic = mergeWithOptimisticImpl

export type PollerLoopName = 'active' | 'list' | 'presence'

export type MentionEvent = {
  conv: ConvKey
  message: ChatMessage
  // 'active' fires when the user is actively viewing the conv whose poll
  // returned a new mention. 'list-diff' fires from the list loop's cross-
  // chat scan when a non-active 1:1/group chat got a new mention.
  source: 'active' | 'list-diff'
  // 'mention' = structured @me; 'message' = plain 1:1/group chat message
  // (only when settings.notifyChatMessages is on).
  kind: NotifyKind
}

export type PollerOpts = {
  store: AccountStore
  // Bound Graph client for the session's account. Called per request so a
  // routing change for this account applies to the next call.
  getClient: () => GraphClient
  intervals?: {
    activeMs?: number
    listMs?: number
    presenceMs?: number
  }
  onMention?: (event: MentionEvent) => void
  onError?: (loop: PollerLoopName, err: Error) => void
  // Concurrent mode: the chat-list filter from the root store (a background
  // account's view resets it). Absent: the store's own.
  listFilter?: () => string
}

// Mutable ref to the active poller handle. The handle is not available
// at first render because bootstrap is async; the UI tree reads a
// `{ current }` box (written by the AccountManager) rather than passing
// a handle through props/context that does not exist yet.
export type PollerHandleRef = { current: PollerHandle | null }

export type PollerHandle = {
  // Returns once the loops have observed the stop flag and exited their
  // current iteration. In-flight fetches are aborted via AbortController.
  stop: () => Promise<void>
  // Wake the active and list sleepers immediately so the next iteration
  // runs without waiting out the current interval. Useful when the user
  // hits a manual-refresh key.
  refresh: () => void
  // Clear visible account-scoped data and wake the pollers. This is the
  // escape hatch for a stale/stuck UI: the next list/active iterations
  // rebuild state from Graph rather than preserving old slices.
  hardRefresh: () => void
  // Fetch one older page for `focus` (captured by the caller, so a focus
  // change mid-fetch can't redirect the page to another conversation).
  loadOlderMessages: (focus: Focus) => Promise<LoadOlderMessagesResult>
}

export function startPoller(opts: PollerOpts): PollerHandle {
  const { store, getClient, onMention, onError } = opts
  // When the caller passes explicit interval overrides (tests do this
  // to drive the loops at sub-second cadence), we honor them verbatim.
  // Otherwise each loop reads its current interval from the store on
  // every iteration: trouter-connected → 60s, trouter-degraded → the
  // per-loop default, terminal blurred → 5min. This keeps the degraded
  // state usable without paying for fast polls when push is healthy.
  const activeMs: number | (() => number) =
    opts.intervals?.activeMs ?? (() => adaptiveIntervalMs(ACTIVE_DEFAULT_MS, store.get()))
  const listMs: number | (() => number) =
    opts.intervals?.listMs ?? (() => adaptiveIntervalMs(LIST_DEFAULT_MS, store.get()))
  const presenceMs: number | (() => number) =
    opts.intervals?.presenceMs ?? (() => adaptiveIntervalMs(PRESENCE_DEFAULT_MS, store.get()))

  // --- Shared state ---

  let stopped = false
  const isStopped = () => stopped

  // seen-message-ID set, shared between active loop and list loop's
  // cross-chat probe so a list-diff seed prevents the active loop from
  // re-notifying the same IDs when the user opens that chat.
  const seen = new Map<ConvKey, Set<string>>()

  const listSleeper = makeSleeper()
  const presenceSleeper = makeSleeper()

  // One active loop per pane side. Each has its own sleeper and a
  // per-iteration AbortController slot, so the target-change subscriber and
  // stop() can cancel one side's in-flight fetch without touching the other.
  type ActiveSide = { side: PaneSide; sleeper: Sleeper; abort: AbortController | null }
  const sides: ActiveSide[] = (['left', 'right'] as const).map((side) => ({
    side,
    sleeper: makeSleeper(),
    abort: null,
  }))
  const target = (side: PaneSide): Focus => paneFocus(store.get(), side)

  // Conversations whose fetch returned 403: sticky for the session and
  // shared by both sides, so moving a blocked conversation to the other pane
  // does not retry it.
  const blocked = new Set<ConvKey>()

  // A channel and one of its threads in the two panes return the same
  // replies under different keys. A reply new to one side is also recorded
  // in the other side's seen set (when that set exists), so one message
  // notifies once.
  const overlapKeys = (side: PaneSide, focus: Focus): ConvKey[] => {
    const other = target(side === 'left' ? 'right' : 'left')
    if (focus.kind !== 'channel' && focus.kind !== 'thread') return []
    if (other.kind !== 'channel' && other.kind !== 'thread') return []
    if (other.teamId !== focus.teamId || other.channelId !== focus.channelId) return []
    const key = focusKey(other)
    return key && key !== focusKey(focus) ? [key] : []
  }

  // Hot-stop signal for background member hydration started by the list
  // loop. Owned at this layer so stop() can abort it independently of
  // the per-iteration listAbort.
  const hydrateAbort = new AbortController()

  // Session-wide stop signal. Each loop combines this with its per-
  // iteration AbortController via AbortSignal.any so stop() can abort
  // in-flight list/presence fetches the same way it aborts active.
  // Without this, account switching and shutdown can hang on slow
  // network calls in those loops.
  const sessionAbort = new AbortController()

  // Set of chat IDs already hydrated via $batch. Owned here so
  // hardRefresh can clear it (otherwise unresolved chat names would
  // stay stale across the explicit refresh the user just asked for).
  const memberHydrated = new Set<string>()

  // Wake a side's loop and abort its in-flight fetch when its target
  // changes; the other side keeps going. A side whose chat comes on screen
  // (a hidden passive pane shown) is woken too, so its next poll marks it
  // read.
  const sideKey = (state: AccountView, side: PaneSide) => focusKey(paneFocus(state, side))
  const isViewed = (state: AccountView, key: ConvKey | null) =>
    key !== null && key.startsWith('chat:') && visibleConvKeys(state).includes(key)
  const last = sides.map((x) => {
    const key = sideKey(store.get(), x.side)
    return { key, viewed: isViewed(store.get(), key) }
  })
  const unsubscribe = store.subscribe((state) => {
    sides.forEach((x, i) => {
      const key = sideKey(state, x.side)
      const viewed = isViewed(state, key)
      const prev = last[i]!
      if (key !== prev.key) {
        x.abort?.abort()
        x.sleeper.wake()
      } else if (viewed && !prev.viewed) {
        x.sleeper.wake()
      }
      last[i] = { key, viewed }
    })
  })

  function reportError(loop: PollerLoopName, err: unknown): void {
    if (isAbortError(err)) return
    onError?.(loop, err instanceof Error ? err : new Error(String(err)))
  }

  function loadOlderMessages(focus: Focus): Promise<LoadOlderMessagesResult> {
    return loadOlderMessagesImpl({
      store,
      focus,
      getClient,
      reportError: (err) => reportError('active', err),
      signal: sessionAbort.signal,
    })
  }

  // --- Loop factories ---

  const activeLoops = sides.map((x) =>
    makeActiveLoop({
      store,
      target: () => target(x.side),
      getClient,
      sleeper: x.sleeper,
      intervalMs: activeMs,
      seen,
      blocked,
      overlapKeys: (focus) => overlapKeys(x.side, focus),
      setActiveAbort: (c) => {
        x.abort = c
      },
      isStopped,
      onMention,
      reportError: (err) => reportError('active', err),
    }),
  )

  const runListLoop = makeListLoop({
    store,
    getClient,
    sleeper: listSleeper,
    intervalMs: listMs,
    seen,
    hydrateSignal: hydrateAbort.signal,
    stopSignal: sessionAbort.signal,
    isStopped,
    onMention,
    reportError: (err) => reportError('list', err),
    memberHydrated,
  })

  const runPresenceLoop = makePresenceLoop({
    store,
    getClient,
    sleeper: presenceSleeper,
    intervalMs: presenceMs,
    stopSignal: sessionAbort.signal,
    isStopped,
    reportError: (err) => reportError('presence', err),
    listFilter: opts.listFilter ?? (() => store.get().filter),
  })

  // Kick off all loops; failures inside any loop are caught locally so
  // Promise.all does not need to short-circuit.
  const loops = Promise.all([
    ...activeLoops.map((run) => run()),
    runListLoop(),
    runPresenceLoop(),
  ]).catch((err) => {
    reportError('active', err)
  })

  return {
    async stop() {
      stopped = true
      unsubscribe()
      for (const x of sides) x.abort?.abort()
      hydrateAbort.abort()
      sessionAbort.abort()
      // close() (not just wake()) latches each sleeper so any in-flight
      // sleep resolves AND any future sleep() inside the loop is a
      // no-op. Without the latch, a loop whose previous sleep just
      // resolved on the timer (waker=null in that window) would start a
      // fresh backoff sleep nobody can wake.
      for (const x of sides) x.sleeper.close()
      listSleeper.close()
      presenceSleeper.close()
      await loops
    },
    refresh() {
      recordEvent('poller', 'info', 'manual refresh requested')
      for (const x of sides) x.sleeper.wake()
      listSleeper.wake()
    },
    hardRefresh() {
      recordEvent('poller', 'info', 'hard refresh requested')
      seen.clear()
      memberHydrated.clear()
      for (const x of sides) x.abort?.abort()
      store.set({
        chats: [],
        teams: [],
        channelsByTeam: {},
        messagesByConvo: {},
        messageCacheByConvo: {},
        unreadByChatId: {},
        conn: 'connecting',
      })
      for (const x of sides) x.sleeper.wake()
      listSleeper.wake()
      presenceSleeper.wake()
    },
    loadOlderMessages,
  }
}
