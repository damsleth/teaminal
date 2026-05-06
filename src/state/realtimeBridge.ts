// Bridge between the RealtimeEventBus and the app store / poller.
//
// Responsibilities:
//   - On 'new-message': wake the poller's active or list sleeper so Graph
//     is re-fetched immediately (< 1s latency instead of 5–30s).
//   - On 'typing' / 'typing-stopped': update typingByConvo in the store.
//   - On 'presence-changed': update myPresence or memberPresence.
//   - On 'read-receipt': track each user's latest seen message.
//   - Clean up stale typing indicators every 2s.
//
// The bridge never trusts push payloads for message content — it only
// uses them as "something changed" signals that trigger authoritative
// Graph fetches through the existing poller.

import type { RealtimeEventBus } from '../realtime/events'
import type { AppState, ConvKey, Store, TypingIndicator } from './store'
import type { PollerHandle } from './poller'

const TYPING_TTL_MS = 8_000
const TYPING_CLEANUP_INTERVAL_MS = 2_000

export type RealtimeBridgeOpts = {
  bus: RealtimeEventBus
  store: Store<AppState>
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
  unsubs.push(
    bus.onKind('new-message', (event) => {
      if (event.kind !== 'new-message') return
      const poller = getPoller()
      if (!poller) return
      // Wake both sleepers. The active loop will re-fetch if the chat
      // matches the current focus; the list loop picks up preview changes.
      poller.refresh()
    }),
  )

  // Also accelerate on chat-updated, chat-created, message-edited, message-deleted.
  for (const kind of [
    'chat-updated',
    'chat-created',
    'message-edited',
    'message-deleted',
    'reaction-added',
  ] as const) {
    unsubs.push(
      bus.onKind(kind, () => {
        getPoller()?.refresh()
      }),
    )
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
              | { availability: infer A }
              | undefined
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
      for (const unsub of unsubs) unsub()
    },
  }
}
