// Hydrate Graph members for the focused chat once.
//
// /chats does not return members on the bulk list (the $expand=members
// shape is capped at 25 with a different schema). Without hydration,
// 1:1 chats render as "(1:1)" and the message-pane header is unhelpful.
//
// The hook fires on focus changes; the poller's list loop also has a
// background hydration pass for chats currently visible in the list.

import { useEffect, useState } from 'react'
import { GraphError } from '../../graph/client'
import { warn } from '../../log'
import { hydrateChat } from '../../state/chatActions'
import type { Focus, Store, AppState } from '../../state/store'

export function useHydrateMembers(focus: Focus, store: Store<AppState>): void {
  // hydrated tracks chat ids we've already issued a getChat call for, so
  // a Tab-into-composer-and-back doesn't re-fetch.
  const [hydrated, setHydrated] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (focus.kind !== 'chat') return
    const chatId = focus.chatId
    if (hydrated.has(chatId)) return
    const existing = store.get().chats.find((c) => c.id === chatId)
    if (existing?.members && existing.members.length > 0) {
      setHydrated((s) => new Set(s).add(chatId))
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const full = await hydrateChat(chatId)
        if (cancelled) return
        store.set((s) => ({
          chats: s.chats.map((c) => (c.id === chatId ? { ...c, members: full.members } : c)),
        }))
        setHydrated((s) => new Set(s).add(chatId))
      } catch (err) {
        if (cancelled) return
        if (err instanceof GraphError) {
          warn(`hydrate members ${chatId}:`, err.message)
        } else {
          warn(`hydrate members ${chatId}:`, String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [focus, hydrated, store])
}
