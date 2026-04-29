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

import { listChats, listMessages } from '../graph/chats'
import { GraphError, RateLimitError } from '../graph/client'
import { getMyPresence } from '../graph/presence'
import { listChannelMessages, listChannels, listJoinedTeams } from '../graph/teams'
import type { Channel, ChatMessage } from '../types'
import {
  type AppState,
  type ConvKey,
  type Focus,
  focusKey,
  type Store,
} from './store'

const ACTIVE_DEFAULT_MS = 5_000
const LIST_DEFAULT_MS = 30_000
const PRESENCE_DEFAULT_MS = 60_000
const BACKOFF_BASE = 1.5
const BACKOFF_CAP_MS = 60_000

export type PollerLoopName = 'active' | 'list' | 'presence'

export type MentionEvent = {
  conv: ConvKey
  message: ChatMessage
  source: 'active'
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
}

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4))
}

function backoff(baseMs: number, consecutive: number): number {
  if (consecutive === 0) return baseMs
  const raised = baseMs * Math.pow(BACKOFF_BASE, consecutive)
  return Math.min(BACKOFF_CAP_MS, raised)
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return true
  // Bun's fetch may throw a DOMException-shaped error with code === 20 or
  // an Error with message containing "aborted". Be permissive.
  return /aborted|abort/i.test(err.message)
}

function shouldNotifyMention(msg: ChatMessage, myUserId: string): boolean {
  if (msg.from?.user?.id === myUserId) return false // own echo
  const mentions = msg.mentions
  if (!mentions || mentions.length === 0) return false
  return mentions.some((m) => m.mentioned?.user?.id === myUserId)
}

// When the active loop overwrites messagesByConvo with a server response,
// any optimistic message the user just sent (and any that failed to send)
// would be lost if we replaced the array wholesale. Preserve them:
//   - _sending: still in flight, append after server messages so the user
//               sees their bubble until the server ack arrives
//   - _sendError: failed sends with no server-side counterpart; keep so
//                  the user can see the error
// Server-confirmed messages take precedence wherever ids overlap.
export function mergeWithOptimistic(
  existing: ChatMessage[],
  server: ChatMessage[],
): ChatMessage[] {
  const serverIds = new Set(server.map((m) => m.id))
  const carry: ChatMessage[] = []
  for (const m of existing) {
    if (m._sending) {
      carry.push(m)
    } else if (m._sendError && !serverIds.has(m.id)) {
      carry.push(m)
    }
  }
  return [...server, ...carry]
}

type Sleeper = {
  sleep(ms: number): Promise<void>
  wake(): void
}

function makeSleeper(): Sleeper {
  let waker: (() => void) | null = null
  return {
    sleep(ms: number) {
      return new Promise<void>((resolve) => {
        const id = setTimeout(() => {
          waker = null
          resolve()
        }, ms)
        waker = () => {
          clearTimeout(id)
          waker = null
          resolve()
        }
      })
    },
    wake() {
      waker?.()
    },
  }
}

async function fetchActiveMessages(
  focus: Focus,
  signal: AbortSignal,
): Promise<ChatMessage[]> {
  if (focus.kind === 'chat') {
    return listMessages(focus.chatId, { signal })
  }
  if (focus.kind === 'channel') {
    return listChannelMessages(focus.teamId, focus.channelId, { signal })
  }
  return []
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
        const messages = await fetchActiveMessages(focus, activeAbort.signal)
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
            messagesByConvo: {
              ...s.messagesByConvo,
              [conv]: mergeWithOptimistic(s.messagesByConvo[conv] ?? [], messages),
            },
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

  async function fetchTeamsAndChannels(
    signal: AbortSignal,
  ): Promise<{ teams: AppState['teams']; channelsByTeam: Record<string, Channel[]> }> {
    const teams = await listJoinedTeams({ signal })
    if (teams.length === 0) return { teams, channelsByTeam: {} }
    const results = await Promise.all(
      teams.map(async (team): Promise<[string, Channel[]]> => {
        try {
          const channels = await listChannels(team.id, { signal })
          return [team.id, channels]
        } catch (err) {
          if (isAbortError(err)) throw err
          // Per-team channel-list failures shouldn't poison the whole list
          // refresh; keep an empty channel list and surface the error.
          reportError('list', err)
          return [team.id, []]
        }
      }),
    )
    const channelsByTeam: Record<string, Channel[]> = {}
    for (const [teamId, channels] of results) channelsByTeam[teamId] = channels
    return { teams, channelsByTeam }
  }

  async function runListLoop(): Promise<void> {
    let consecutiveErrors = 0
    // Bookkeeping AbortController per iteration so stop() can cancel.
    let listAbort: AbortController | null = null
    while (!stopped) {
      listAbort = new AbortController()
      try {
        const [chats, teamsAndChannels] = await Promise.all([
          listChats({ signal: listAbort.signal }),
          fetchTeamsAndChannels(listAbort.signal),
        ])
        if (stopped) return
        store.set({
          chats,
          teams: teamsAndChannels.teams,
          channelsByTeam: teamsAndChannels.channelsByTeam,
          conn: 'online',
        })
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
    while (!stopped) {
      const caps = store.get().capabilities
      // Skip the loop entirely if capability probe marked presence as
      // unavailable; the StatusBar will simply omit the presence dot.
      if (caps && caps.presence.ok === false && caps.presence.reason === 'unavailable') {
        await presenceSleeper.sleep(jitter(presenceMs))
        continue
      }
      presenceAbort = new AbortController()
      try {
        const myPresence = await getMyPresence({ signal: presenceAbort.signal })
        if (stopped) return
        store.set({ myPresence })
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
      activeSleeper.wake()
      listSleeper.wake()
      presenceSleeper.wake()
      await loops
    },
  }
}
