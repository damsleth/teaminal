// Hydrate Graph members for the focused chat once.
//
// /chats does not return members on the bulk list (the $expand=members
// shape is capped at 25 with a different schema). Without hydration,
// 1:1 chats render as "(1:1)" and the message-pane header is unhelpful.
//
// The hook fires on focus changes; the poller's list loop also has a
// background hydration pass for chats currently visible in the list.
// A failed hydrate is retried after a delay, a bounded number of times.

import { useEffect, useRef, useState } from 'react'
import { useSessionApi } from '../SessionContext'
import { GraphError } from '../../graph/client'
import { warn } from '../../log'
import { accountStore } from '../../state/accountStore'
import { hydrateChat } from '../../state/chatActions'
import type { Focus, Store, AppState } from '../../state/store'

const MAX_ATTEMPTS = 3

type Attempt = { ok: boolean; inFlight: boolean; attempts: number; retryAt: number }

export function useHydrateMembers(focus: Focus, store: Store<AppState>, retryMs = 30_000): void {
  const session = useSessionApi()
  // Per account + chat, so another account's chat with the same id is not
  // skipped, and a ref so recording an attempt does not re-run the effect.
  const attempts = useRef(new Map<string, Attempt>())
  // Bumped when a retry is due, to re-run the effect.
  const [retryTick, setRetryTick] = useState(0)
  // Re-run on a foreground swap even when the focus is deep-equal.
  const accountId = store.get().account?.id

  useEffect(() => {
    if (focus.kind !== 'chat') return
    const chatId = focus.chatId
    const key = `${accountId ?? ''}\0${chatId}`
    const entry = attempts.current.get(key) ?? {
      ok: false,
      inFlight: false,
      attempts: 0,
      retryAt: 0,
    }
    attempts.current.set(key, entry)
    if (entry.ok || entry.inFlight || entry.attempts >= MAX_ATTEMPTS) return
    const existing = store.get().chats.find((c) => c.id === chatId)
    if (existing?.members && existing.members.length > 0) {
      entry.ok = true
      return
    }
    const wait = entry.retryAt - Date.now()
    if (wait > 0) {
      const timer = setTimeout(() => setRetryTick((t) => t + 1), wait)
      return () => clearTimeout(timer)
    }
    // Writes are dropped once the store moved to another account.
    const target = accountStore(store)
    entry.inFlight = true
    let retry: ReturnType<typeof setTimeout> | undefined
    hydrateChat(session.client(), chatId)
      .then((full) => {
        entry.ok = true
        target.set((s) => ({
          chats: s.chats.map((c) => (c.id === chatId ? { ...c, members: full.members } : c)),
        }))
      })
      .catch((err) => {
        warn(`hydrate members ${chatId}:`, err instanceof GraphError ? err.message : String(err))
        entry.attempts++
        entry.retryAt = Date.now() + retryMs
        if (entry.attempts < MAX_ATTEMPTS) {
          retry = setTimeout(() => setRetryTick((t) => t + 1), retryMs)
        }
      })
      .finally(() => {
        entry.inFlight = false
      })
    return () => clearTimeout(retry)
  }, [accountId, focus, store, retryMs, retryTick, session])
}
