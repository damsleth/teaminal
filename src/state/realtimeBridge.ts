// Bridge between the RealtimeEventBus and the app store / poller.
//
// Responsibilities:
//   - On 'new-message': wake the poller's active and list sleepers so Graph
//     is re-fetched immediately, then again once Graph has caught up.
//   - On 'typing' / 'typing-stopped': update typingByConvo in the store.
//   - On 'presence-changed': update myPresence or memberPresence.
//   - On 'read-receipt': track each user's latest seen message.
//   - Clean up stale typing indicators every 2s.
//
// The bridge never trusts push payloads for message content — it only
// uses them as "something changed" signals that trigger authoritative
// Graph fetches through the existing poller.

import type { AccountStore } from './accountStore'
import type { RealtimeEventBus } from '../realtime/events'
import { refreshActivityFeed } from './activityFeed'
import type { AppState, ConvKey, TypingIndicator } from './store'
import type { PollerHandle } from './poller'

const TYPING_TTL_MS = 8_000
const TYPING_CLEANUP_INTERVAL_MS = 2_000

export type RealtimeBridgeOpts = {
  bus: RealtimeEventBus
  // Writes after an account switch are dropped by the handle itself.
  store: AccountStore
  /** Set once the poller is started; the bridge tolerates null during bootstrap. */
  getPoller: () => PollerHandle | null
}

export type RealtimeBridgeHandle = {
  stop: () => void
}

export function startRealtimeBridge(opts: RealtimeBridgeOpts): RealtimeBridgeHandle {
  const { bus, store, getPoller } = opts
  const unsubs: (() => void)[] = []

  // --- New-message acceleration ---
  // Push usually beats Graph: an immediate re-fetch often comes back
  // without the message that triggered it, and the next poll is 60s
  // out. So wake the poller now (the active loop re-fetches the focused
  // chat, the list loop picks up preview changes) and once more after
  // Graph has caught up.
  // ponytail: one fixed trailing retry; poll-until-present if 3s proves short.
  const GRAPH_CATCHUP_MS = 3_000
  let catchupTimer: ReturnType<typeof setTimeout> | null = null
  const accelerate = (): void => {
    const poller = getPoller()
    if (!poller) return
    poller.refresh()
    if (catchupTimer) clearTimeout(catchupTimer)
    catchupTimer = setTimeout(() => {
      catchupTimer = null
      getPoller()?.refresh()
    }, GRAPH_CATCHUP_MS)
  }
  for (const kind of [
    'new-message',
    'chat-updated',
    'chat-created',
    'message-edited',
    'message-deleted',
    'reaction-added',
  ] as const) {
    unsubs.push(bus.onKind(kind, accelerate))
  }

  // --- CSA activity feed reconcile ---
  // Trouter push events tell us *something happened*, but the canonical
  // shape we render in the activity modal comes from /api/csa/...updates.
  // Throttle to one refresh every 15s so a flurry of reactions doesn't
  // hammer the endpoint.
  const ACTIVITY_REFRESH_THROTTLE_MS = 15_000
  let lastActivityRefreshAt = 0
  let pendingActivityTimer: ReturnType<typeof setTimeout> | null = null
  const refreshActivity = (): void => {
    const now = Date.now()
    const wait = Math.max(0, ACTIVITY_REFRESH_THROTTLE_MS - (now - lastActivityRefreshAt))
    if (pendingActivityTimer) return
    pendingActivityTimer = setTimeout(() => {
      pendingActivityTimer = null
      lastActivityRefreshAt = Date.now()
      void refreshActivityFeed(store)
    }, wait)
  }

  for (const kind of ['new-message', 'reaction-added', 'message-edited'] as const) {
    unsubs.push(bus.onKind(kind, refreshActivity))
  }

  // --- Typing indicators ---
  unsubs.push(
    bus.onKind('typing', (event) => {
      if (event.kind !== 'typing') return
      const conv: ConvKey = `chat:${event.chatId}`
      store.set((s) => {
        const existing = s.typingByConvo[conv] ?? []
        const now = Date.now()
        const entry: TypingIndicator = {
          userId: event.userId,
          displayName: event.displayName ?? event.userId,
          startedAt: now,
        }
        // Upsert: refresh startedAt if already present, append if new.
        const updated = existing.some((t) => t.userId === event.userId)
          ? existing.map((t) => (t.userId === event.userId ? entry : t))
          : [...existing, entry]
        return {
          typingByConvo: { ...s.typingByConvo, [conv]: updated },
        }
      })
    }),
  )

  unsubs.push(
    bus.onKind('typing-stopped', (event) => {
      if (event.kind !== 'typing-stopped') return
      const conv: ConvKey = `chat:${event.chatId}`
      store.set((s) => {
        const existing = s.typingByConvo[conv]
        if (!existing || existing.length === 0) return {}
        const filtered = existing.filter((t) => t.userId !== event.userId)
        if (filtered.length === existing.length) return {}
        const next = { ...s.typingByConvo }
        if (filtered.length === 0) delete next[conv]
        else next[conv] = filtered
        return { typingByConvo: next }
      })
    }),
  )

  // --- Read receipts ---
  unsubs.push(
    bus.onKind('read-receipt', (event) => {
      if (event.kind !== 'read-receipt') return
      const conv: ConvKey = `chat:${event.chatId}`
      store.set((s) => ({
        readReceiptsByConvo: {
          ...s.readReceiptsByConvo,
          [conv]: {
            ...(s.readReceiptsByConvo[conv] ?? {}),
            [event.userId]: {
              userId: event.userId,
              messageId: event.messageId,
              seenAt: Date.now(),
            },
          },
        },
      }))
    }),
  )

  // --- Presence (instant updates from push) ---
  unsubs.push(
    bus.onKind('presence-changed', (event) => {
      if (event.kind !== 'presence-changed') return
      const myId = store.get().me?.id
      if (event.userId === myId) {
        store.set({
          myPresence: {
            id: event.userId,
            availability: event.availability as AppState['myPresence'] extends
              { availability: infer A } | undefined
              ? A
              : string,
            activity: event.availability as string & {},
          },
        })
      } else {
        // Update member presence for any user we've ever seen, and seed
        // new entries too. The bridge cannot know which user ids the
        // chat list cares about, but the cost of an extra map entry is
        // negligible and it lets push notifications instantly populate
        // dots for users the periodic poll has not yet covered.
        store.set((s) => {
          const existing = s.memberPresence[event.userId]
          return {
            memberPresence: {
              ...s.memberPresence,
              [event.userId]: {
                id: event.userId,
                availability:
                  event.availability as AppState['memberPresence'][string]['availability'],
                activity: (existing?.activity ??
                  event.availability) as AppState['memberPresence'][string]['activity'],
              },
            },
          }
        })
      }
    }),
  )

  // --- Stale typing cleanup timer ---
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    const current = store.get().typingByConvo
    let changed = false
    const next: Record<ConvKey, TypingIndicator[]> = {}
    for (const [conv, indicators] of Object.entries(current)) {
      const live = indicators.filter((t) => now - t.startedAt < TYPING_TTL_MS)
      if (live.length !== indicators.length) changed = true
      if (live.length > 0) next[conv] = live
    }
    if (changed) {
      store.set({ typingByConvo: next })
    }
  }, TYPING_CLEANUP_INTERVAL_MS)

  return {
    stop() {
      clearInterval(cleanupTimer)
      if (catchupTimer) clearTimeout(catchupTimer)
      if (pendingActivityTimer) {
        clearTimeout(pendingActivityTimer)
        pendingActivityTimer = null
      }
      for (const unsub of unsubs) unsub()
    },
  }
}
