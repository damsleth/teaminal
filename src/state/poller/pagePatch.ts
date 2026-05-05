// State-shaped patch produced when the active loop applies a fresh page
// of messages for the focused conversation. Preserves older cached
// pages and optimistic sends; updates the unread tracker for chats.

import type { ChatMessage } from '../../types'
import { type AppState, type ConvKey, type Focus, emptyMessageCache, markChatRead } from '../store'
import { mergeWithOptimistic, newestMessageId } from './merge'

export type MessagesPage = {
  messages: ChatMessage[]
  nextLink?: string
}

/**
 * Compute the partial-state patch to apply when the active loop fetches
 * a fresh top-of-list page for `conv`. Designed to:
 *
 *   - merge with any optimistic messages without dropping them,
 *   - preserve older cached pages and pagination cursors when the cache
 *     already has older messages the new page does not include,
 *   - clamp the message cursor to the new bounds,
 *   - mark the chat read for `unreadByChatId` when the focus is a chat.
 */
export function mergeActivePagePatch(
  state: AppState,
  conv: ConvKey,
  page: MessagesPage,
  focus: Focus,
): Partial<AppState> {
  const cache = state.messageCacheByConvo[conv]
  const legacyMessages = state.messagesByConvo[conv] ?? []
  const existing = cache?.messages ?? legacyMessages
  const merged = mergeWithOptimistic(existing, page.messages)

  const incomingIds = new Set(page.messages.map((m) => m.id))
  const hasCachedOlderMessages = existing.some(
    (m) => !incomingIds.has(m.id) && !m._sending && !m._sendError,
  )
  const preserveOlderPaging = hasCachedOlderMessages && cache !== undefined
  const nextLink = preserveOlderPaging ? cache.nextLink : page.nextLink
  const fullyLoaded = preserveOlderPaging
    ? (cache?.fullyLoaded ?? false)
    : page.nextLink === undefined
  const nextCaches = {
    ...state.messageCacheByConvo,
    [conv]: {
      ...(cache ?? emptyMessageCache()),
      messages: merged,
      nextLink,
      loadingOlder: false,
      fullyLoaded,
      error: undefined,
    },
  }
  const prevCursor = state.messageCursorByConvo[conv]
  const nextCursor =
    prevCursor === undefined
      ? Math.max(0, merged.length - 1)
      : Math.min(prevCursor, Math.max(0, merged.length - 1))
  const patch: Partial<AppState> = {
    messageCacheByConvo: nextCaches,
    messagesByConvo: {
      ...state.messagesByConvo,
      [conv]: merged,
    },
    messageCursorByConvo: {
      ...state.messageCursorByConvo,
      [conv]: nextCursor,
    },
  }
  if (focus.kind === 'chat') {
    patch.unreadByChatId = markChatRead(state.unreadByChatId, focus.chatId, newestMessageId(merged))
  }
  return patch
}
