// Adaptive polling loops with backoff, jitter, focus-driven cancellation,
// and seed-on-startup notification dedupe.
//
// Three independent loops run concurrently:
//
//   - active   (~5s): re-fetches messages for the currently-focused chat
//                     or channel. Seeds the seen-message-ID set on first
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

import type { ChatMessage } from '../types'
import { type AppState, type ConvKey, focusKey, type Store } from './store'
import {
  ACTIVE_DEFAULT_MS,
  LIST_DEFAULT_MS,
  PRESENCE_DEFAULT_MS,
  isAbortError,
} from './poller/intervals'
import { makeSleeper } from './poller/sleeper'
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
}

export type PollerOpts = {
  store: Store<AppState>
  intervals?: {
    activeMs?: number
    listMs?: number
    presenceMs?: number
  }
  onMention?: (event: MentionEvent) => void
  onError?: (loop: PollerLoopName, err: Error) => void
}

export type PollerHandle = {
  // Returns once the loops have observed the stop flag and exited their
  // current iteration. In-flight fetches are aborted via AbortController.
  stop: () => Promise<void>
  // Wake the active and list sleepers immediately so the next iteration
  // runs without waiting out the current interval. Useful when the user
  // hits a manual-refresh key.
  refresh: () => void
  // Fetch one older page for the currently-focused conversation, if any.
  loadOlderMessages: () => Promise<LoadOlderMessagesResult>
}

export function startPoller(opts: PollerOpts): PollerHandle {
  const { store, onMention, onError } = opts
  const activeMs = opts.intervals?.activeMs ?? ACTIVE_DEFAULT_MS
  const listMs = opts.intervals?.listMs ?? LIST_DEFAULT_MS
  const presenceMs = opts.intervals?.presenceMs ?? PRESENCE_DEFAULT_MS

  // --- Shared state ---

  let stopped = false
  const isStopped = () => stopped

  // seen-message-ID set, shared between active loop and list loop's
  // cross-chat probe so a list-diff seed prevents the active loop from
  // re-notifying the same IDs when the user opens that chat.
  const seen = new Map<ConvKey, Set<string>>()

  const activeSleeper = makeSleeper()
  const listSleeper = makeSleeper()
  const presenceSleeper = makeSleeper()

  // Per-iteration AbortController for the active loop, exposed so the
  // focus-change subscriber and stop() can cancel the in-flight fetch.
  let activeAbort: AbortController | null = null
  const setActiveAbort = (c: AbortController | null): void => {
    activeAbort = c
  }

  // Hot-stop signal for background member hydration started by the list
  // loop. Owned at this layer so stop() can abort it independently of
  // the per-iteration listAbort.
  const hydrateAbort = new AbortController()

  // Wake the active loop and abort its in-flight fetch when focus changes.
  let lastFocusKey = focusKey(store.get().focus)
  const unsubscribe = store.subscribe((state) => {
    const k = focusKey(state.focus)
    if (k !== lastFocusKey) {
      lastFocusKey = k
      activeAbort?.abort()
      activeSleeper.wake()
    }
  })

  function reportError(loop: PollerLoopName, err: unknown): void {
    if (isAbortError(err)) return
    onError?.(loop, err instanceof Error ? err : new Error(String(err)))
  }

  function loadOlderMessages(): Promise<LoadOlderMessagesResult> {
    return loadOlderMessagesImpl({
      store,
      reportError: (err) => reportError('active', err),
    })
  }

  // --- Loop factories ---

  const runActiveLoop = makeActiveLoop({
    store,
    sleeper: activeSleeper,
    intervalMs: activeMs,
    seen,
    setActiveAbort,
    isStopped,
    onMention,
    reportError: (err) => reportError('active', err),
  })

  const runListLoop = makeListLoop({
    store,
    sleeper: listSleeper,
    intervalMs: listMs,
    seen,
    hydrateSignal: hydrateAbort.signal,
    isStopped,
    onMention,
    reportError: (err) => reportError('list', err),
  })

  const runPresenceLoop = makePresenceLoop({
    store,
    sleeper: presenceSleeper,
    intervalMs: presenceMs,
    isStopped,
    reportError: (err) => reportError('presence', err),
  })

  // Kick off all loops; failures inside any loop are caught locally so
  // Promise.all does not need to short-circuit.
  const loops = Promise.all([runActiveLoop(), runListLoop(), runPresenceLoop()]).catch((err) => {
    reportError('active', err)
  })

  return {
    async stop() {
      stopped = true
      unsubscribe()
      activeAbort?.abort()
      hydrateAbort.abort()
      // close() (not just wake()) latches each sleeper so any in-flight
      // sleep resolves AND any future sleep() inside the loop is a
      // no-op. Without the latch, a loop whose previous sleep just
      // resolved on the timer (waker=null in that window) would start a
      // fresh backoff sleep nobody can wake.
      activeSleeper.close()
      listSleeper.close()
      presenceSleeper.close()
      await loops
    },
    refresh() {
      activeSleeper.wake()
      listSleeper.wake()
    },
    loadOlderMessages,
  }
}
