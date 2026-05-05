// In-conversation message search keybind handler.
//
// Active when AppState.inputZone === 'message-search'. The search bar
// renders inside MessagePane; this handler owns its keys.
//   typed chars         build the query
//   Backspace           edit the query
//   Enter               jump cursor to the most-recent hit
//   n / N               step to next / previous hit (newer / older)
//   Esc                 close, restore previous focus

import { focusKey, type AppState, type ConvKey, type Focus, type Store } from '../../state/store'
import { newestHitIndex, searchMessages, stepHit } from '../messageSearch'
import type { ChatMessage } from '../../types'
import type { KeyResult, RawKey } from './types'

export type MessageSearchKeysCtx = {
  store: Store<AppState>
  focus: Focus
  query: string
  focusedHitId: string | null
  // The conv's messages array, newest last.
  messages: ChatMessage[]
}

export function handleMessageSearchKeys(
  { input, key }: RawKey,
  ctx: MessageSearchKeysCtx,
): KeyResult {
  const { store, focus, query, focusedHitId, messages } = ctx
  const conv: ConvKey | null = focusKey(focus)
  if (!conv) return 'pass'

  if (key.escape) {
    store.set({
      inputZone: 'list',
      messageSearchQuery: '',
      messageSearchFocusedId: null,
    })
    return 'handled'
  }

  if (key.return) {
    const hits = searchMessages(messages, query)
    const idx = newestHitIndex(hits)
    if (idx !== null) {
      const hit = messages[idx]
      store.set((s) => ({
        messageCursorByConvo: { ...s.messageCursorByConvo, [conv]: idx },
        messageSearchFocusedId: hit?.id ?? null,
      }))
    }
    return 'handled'
  }

  if (input === 'n' || input === 'N') {
    const hits = searchMessages(messages, query)
    const currentIndex = focusedHitId ? messages.findIndex((m) => m.id === focusedHitId) : -1
    const next = stepHit(hits, currentIndex >= 0 ? currentIndex : null, input === 'n' ? 1 : -1)
    if (next !== null) {
      const hit = messages[next]
      store.set((s) => ({
        messageCursorByConvo: { ...s.messageCursorByConvo, [conv]: next },
        messageSearchFocusedId: hit?.id ?? null,
      }))
    }
    return 'handled'
  }

  if (key.backspace || key.delete) {
    store.set({ messageSearchQuery: query.slice(0, -1) })
    return 'handled'
  }

  if (input && !key.ctrl && !key.meta && input.length === 1) {
    store.set({ messageSearchQuery: query + input })
    return 'handled'
  }

  return 'pass'
}
