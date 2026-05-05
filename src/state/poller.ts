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
//   - list     (~30s): refreshes /chats with lastMessagePreview, joined
//                      teams, and per-team channel lists. v1 does not do
//                      cross-chat mention detection on the list diff -
//                      that lands as a follow-on once the UI surfaces
//                      a need for it.
//   - presence (~60s): refreshes /me/presence when capability is ok.
//                      Member presence is intentionally skipped in v1
//                      and added once the UI has a place to render it.
//
// Each loop has its own consecutive-error counter and an exponential
// backoff capped at 60s; the next interval gets +/-20% jitter so multiple
// teaminal instances do not align.
//
// Focus change wakes the active loop's interruptable sleep and aborts any
// in-flight active fetch so opening a chat is responsive even mid-poll.

import { listChats, listMessagesPage } from '../graph/chats'
import { GraphError, getActiveProfile, RateLimitError } from '../graph/client'
import { getMyPresence } from '../graph/presence'
import { getMyTeamsPresence, TeamsPresenceError } from '../graph/teamsPresence'
import { listChannelMessagesPage } from '../graph/teams'
import type { ChatMessage, Presence } from '../types'
import {
  type AppState,
  type ConvKey,
  type Focus,
  focusKey,
  seedChatActivity,
  type Store,
} from './store'
import { fetchTeamsAndChannels } from './poller/teamsAndChannels'
import { runCrossChatMentionPass } from './poller/crossChatMentions'
import { hydrateMissingMembers } from './poller/hydrateMembers'
import { mergeChatMembers } from './poller/chatList'
import {
  ACTIVE_DEFAULT_MS,
  LIST_DEFAULT_MS,
  MEMBER_PRESENCE_LIMIT,
  PRESENCE_DEFAULT_MS,
  backoff,
  isAbortError,
  jitter,
} from './poller/intervals'
import { fetchMemberPresence } from './poller/memberPresence'
import { mergeWithOptimistic as mergeWithOptimisticImpl } from './poller/merge'
import { shouldNotifyMention } from './poller/mentions'
import { mergeActivePagePatch, type MessagesPage } from './poller/pagePatch'
import { makeSleeper } from './poller/sleeper'

import {
  loadOlderMessages as loadOlderMessagesImpl,
  type LoadOlderMessagesResult,
} from './poller/loadOlder'

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

async function fetchActiveMessages(focus: Focus, signal: AbortSignal): Promise<MessagesPage> {
  if (focus.kind === 'chat') {
    return listMessagesPage(focus.chatId, { signal })
  }
  if (focus.kind === 'channel') {
    return listChannelMessagesPage(focus.teamId, focus.channelId, { signal })
  }
  return { messages: [] }
}

export function startPoller(opts: PollerOpts): PollerHandle {
  const { store, onMention, onError } = opts
  const activeMs = opts.intervals?.activeMs ?? ACTIVE_DEFAULT_MS
  const listMs = opts.intervals?.listMs ?? LIST_DEFAULT_MS
  const presenceMs = opts.intervals?.presenceMs ?? PRESENCE_DEFAULT_MS

  let stopped = false

  // seen-message-ID set for notification dedupe, keyed by ConvKey.
  // First fetch for a conv populates without notifying; subsequent fetches
  // diff against this set.
  const seen = new Map<ConvKey, Set<string>>()

  const activeSleeper = makeSleeper()
  const listSleeper = makeSleeper()
  const presenceSleeper = makeSleeper()

  let activeAbort: AbortController | null = null

  // Wake the active loop and abort its in-flight fetch when focus changes,
  // so opening a chat doesn't have to wait out the current poll interval.
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

  function extraBackoffForRateLimit(err: unknown): number {
    if (err instanceof RateLimitError && err.retryAfterMs > 0) return err.retryAfterMs
    return 0
  }

  function loadOlderMessages(): Promise<LoadOlderMessagesResult> {
    return loadOlderMessagesImpl({
      store,
      reportError: (err) => reportError('active', err),
    })
  }

  async function runActiveLoop(): Promise<void> {
    let consecutiveErrors = 0
    while (!stopped) {
      const focus = store.get().focus
      const conv = focusKey(focus)
      if (!conv) {
        await activeSleeper.sleep(jitter(activeMs))
        continue
      }
      activeAbort = new AbortController()
      try {
        const page = await fetchActiveMessages(focus, activeAbort.signal)
        const messages = page.messages
        if (stopped) return
        // Only apply if the focus is still on the same conversation - the
        // user may have moved on while we were in flight.
        const stillSame = focusKey(store.get().focus) === conv
        if (stillSame) {
          const isFirst = !seen.has(conv)
          const seenSet = seen.get(conv) ?? new Set<string>()
          const myId = store.get().me?.id
          const newMentions: ChatMessage[] = []
          for (const msg of messages) {
            if (seenSet.has(msg.id)) continue
            seenSet.add(msg.id)
            if (!isFirst && myId && shouldNotifyMention(msg, myId)) {
              newMentions.push(msg)
            }
          }
          seen.set(conv, seenSet)
          store.set((s) => ({
            ...mergeActivePagePatch(s, conv, page, focus),
          }))
          for (const msg of newMentions) {
            onMention?.({ conv, message: msg, source: 'active' })
          }
        }
        consecutiveErrors = 0
      } catch (err) {
        if (!isAbortError(err)) {
          consecutiveErrors++
          reportError('active', err)
        }
      } finally {
        activeAbort = null
      }
      const wait = jitter(backoff(activeMs, consecutiveErrors))
      await activeSleeper.sleep(wait + extraBackoffForRateLimit(undefined))
    }
  }

  // Per-chat snapshot of the last seen lastMessagePreview.id, used to
  // detect new activity in non-active chats between list polls. Seeded
  // on the very first list poll without firing any notifications.
  const prevPreviewIds = new Map<string, string>()
  let firstListPoll = true

  // Tracks chat IDs we've already issued a getChat($expand=members) call
  // for; once a chat is hydrated its members are carried forward via
  // mergeChatMembers, so re-fetching on every list poll is wasted work.
  const memberHydrated = new Set<string>()
  const hydrateAbort = new AbortController()

  async function runListLoop(): Promise<void> {
    let consecutiveErrors = 0
    // Bookkeeping AbortController per iteration so stop() can cancel.
    let listAbort: AbortController | null = null
    while (!stopped) {
      listAbort = new AbortController()
      try {
        const [chats, teamsAndChannels] = await Promise.all([
          listChats({ signal: listAbort.signal }),
          fetchTeamsAndChannels(listAbort.signal, (err) => reportError('list', err)),
        ])
        if (stopped) return
        store.set((s) => ({
          chats: mergeChatMembers(s.chats, chats),
          teams: teamsAndChannels.teams,
          channelsByTeam: teamsAndChannels.channelsByTeam,
          conn: 'online',
          lastListPollAt: new Date(),
        }))

        // Fire-and-forget: don't block the next list-poll iteration on
        // member hydration. Concurrency-capped inside the function.
        hydrateMissingMembers(
          {
            store,
            hydrated: memberHydrated,
            signal: hydrateAbort.signal,
            isStopped: () => stopped,
            reportError: (err) => reportError('list', err),
          },
          chats,
        ).catch((err) => {
          if (!isAbortError(err)) reportError('list', err)
        })

        const myId = store.get().me?.id
        const wasFirst = firstListPoll
        firstListPoll = false
        if (myId && !wasFirst) {
          await runCrossChatMentionPass(
            {
              store,
              seen,
              prevPreviewIds,
              onMention,
              reportError: (err) => reportError('list', err),
            },
            chats,
            myId,
            listAbort.signal,
          )
        } else {
          // Seed prevPreviewIds without firing anything.
          for (const chat of chats) {
            const id = chat.lastMessagePreview?.id
            if (id) prevPreviewIds.set(chat.id, id)
          }
          store.set((s) => ({
            unreadByChatId: seedChatActivity(s.unreadByChatId, chats),
          }))
        }
        consecutiveErrors = 0
      } catch (err) {
        if (!isAbortError(err)) {
          consecutiveErrors++
          reportError('list', err)
          if (err instanceof GraphError && err.status === 401) {
            store.set({ conn: 'authError' })
          } else if (err instanceof RateLimitError) {
            store.set({ conn: 'rateLimited' })
          } else {
            store.set({ conn: 'offline' })
          }
        }
      } finally {
        listAbort = null
      }
      await listSleeper.sleep(jitter(backoff(listMs, consecutiveErrors)))
    }
  }

  async function runPresenceLoop(): Promise<void> {
    let consecutiveErrors = 0
    let presenceAbort: AbortController | null = null
    // Once Teams unified presence has failed in a way that's clearly
    // not transient (auth/scope/tenant policy), don't keep hitting that
    // host every 60s. Fall back to the Graph path for the rest of the
    // session and let the next teaminal launch retry.
    let teamsPresenceUnreachable = false
    while (!stopped) {
      const state = store.get()
      const caps = state.capabilities
      const teamsPresenceEnabled = state.settings.useTeamsPresence !== false
      const useTeams = teamsPresenceEnabled && !teamsPresenceUnreachable
      const useGraph = caps?.presence.ok !== false

      if (!useTeams && !useGraph) {
        // Both paths are off; presence stays whatever the realtime
        // bridge / store seeded.
        await presenceSleeper.sleep(jitter(presenceMs))
        continue
      }

      presenceAbort = new AbortController()
      let updated = false
      try {
        if (useTeams) {
          try {
            const teams = await getMyTeamsPresence({
              profile: getActiveProfile(),
              signal: presenceAbort.signal,
            })
            if (stopped) return
            if (teams) {
              const meId = store.get().me?.id ?? teams.oid
              store.set({
                myPresence: {
                  id: meId,
                  availability: teams.availability as Presence['availability'],
                  activity: teams.activity as Presence['activity'],
                },
              })
              updated = true
            }
          } catch (err) {
            if (isAbortError(err)) {
              // fall through to finally; don't bump errors or fall back.
            } else if (
              err instanceof TeamsPresenceError &&
              (err.status === 401 || err.status === 403 || err.status === 404)
            ) {
              // Hard auth/scope failure or wrong-tenant; stop trying for
              // this session, surface once, and fall through to Graph.
              teamsPresenceUnreachable = true
              reportError('presence', err)
            } else {
              throw err
            }
          }
        }
        if (!updated && useGraph) {
          const myPresence = await getMyPresence({ signal: presenceAbort.signal })
          if (stopped) return
          store.set({ myPresence })
        }

        // --- Other-user presence for the chat-list dot ---
        // Collect the "other" AAD user id for each hydrated 1:1 chat,
        // capped at MEMBER_PRESENCE_LIMIT to bound the cost. Honors the
        // showPresenceInList setting so a user who hides the dot does
        // not pay for the lookup. Failures here never bubble - missing
        // member presence simply renders nothing.
        const stateAfterSelf = store.get()
        const wantsMembers = stateAfterSelf.settings.showPresenceInList !== false
        if (wantsMembers && !presenceAbort.signal.aborted) {
          const meId = stateAfterSelf.me?.id
          const oids: string[] = []
          const seen = new Set<string>()
          for (const chat of stateAfterSelf.chats) {
            if (chat.chatType !== 'oneOnOne') continue
            const other = (chat.members ?? []).find((m) => m.userId && m.userId !== meId)
            const id = other?.userId
            if (!id || seen.has(id)) continue
            seen.add(id)
            oids.push(id)
            if (oids.length >= MEMBER_PRESENCE_LIMIT) break
          }
          if (oids.length > 0) {
            try {
              const fetched = await fetchMemberPresence(oids, {
                useTeams,
                useGraph,
                signal: presenceAbort.signal,
              })
              if (stopped) return
              if (fetched.size > 0) {
                store.set((s) => {
                  const next = { ...s.memberPresence }
                  for (const [id, p] of fetched) next[id] = p
                  return { memberPresence: next }
                })
              }
            } catch (err) {
              if (!isAbortError(err)) {
                // Don't bump consecutiveErrors: self-presence already
                // succeeded, and we don't want a transient member-
                // presence failure to put the whole loop in backoff.
                reportError('presence', err)
              }
            }
          }
        }

        consecutiveErrors = 0
      } catch (err) {
        if (!isAbortError(err)) {
          consecutiveErrors++
          reportError('presence', err)
        }
      } finally {
        presenceAbort = null
      }
      await presenceSleeper.sleep(jitter(backoff(presenceMs, consecutiveErrors)))
    }
  }

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
      // fresh backoff sleep nobody can wake — that's the source of the
      // multi-second afterEach hangs we used to see in poller.test.ts.
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
