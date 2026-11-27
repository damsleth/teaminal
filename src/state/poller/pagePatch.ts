// State-shaped patch produced when the active loop applies a fresh page
// of messages for the focused conversation. Preserves older cached
// pages and optimistic sends; updates the unread tracker for chats.

import type { ChatMessage } from '../../types'
import { indexNamesFromMessages } from '../nameIndex'
import {
  type AccountSlice,
  type AppState,
  type ConvKey,
  type Focus,
  emptyMessageCache,
  markChatRead,
} from '../store'
import { mergeWithOptimistic, newestMessageId, sameMessageList } from './merge'

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
): Partial<AccountSlice> {
  const cache = state.messageCacheByConvo[conv]
  const legacyMessages = state.messagesByConvo[conv] ?? []
  // When a cache exists, prefer it, but pick up any optimistic
  // _sending/_sendError rows from the legacy mirror that the cache
  // has not yet seen. sendMessage writes both maps when a cache exists
  // (convPatch); a row written while the conversation had no cache lives
  // only in messagesByConvo, and this rescue keeps it if a cache appears
  // without it.
  const cachedMessages = cache?.messages ?? []
  const cachedIds = new Set(cachedMessages.map((m) => m.id))
  const orphanOptimistic = cache
    ? legacyMessages.filter((m) => (m._sending || m._sendError) && !cachedIds.has(m.id))
    : []
  const existing = cache ? [...cachedMessages, ...orphanOptimistic] : legacyMessages
  const mergedFresh = mergeWithOptimistic(existing, page.messages)
  // A poll that returns the same messages must not produce a new array, or
  // every subscriber re-renders on a 5s timer. Prefer the list already in the
  // store (cache first, then the legacy mirror) whenever it is
  // render-equivalent, so the reference survives.
  const merged = sameMessageList(cachedMessages, mergedFresh)
    ? cachedMessages
    : sameMessageList(legacyMessages, mergedFresh)
      ? legacyMessages
      : mergedFresh

  const incomingIds = new Set(page.messages.map((m) => m.id))
  const hasCachedOlderMessages = existing.some(
    (m) => !incomingIds.has(m.id) && !m._sending && !m._sendError,
  )
  // The cache's older-page cursor is only good when the fresh page reaches
  // back into the cached messages. With no overlap (a gap after time away)
  // or a cursor lost to trimming, page from the fresh page instead: older
  // fetches walk back through the gap and the merge dedupes the overlap.
  const overlapsCache = page.messages.some((m) => cachedIds.has(m.id))
  const keepCachePaging =
    hasCachedOlderMessages &&
    cache !== undefined &&
    overlapsCache &&
    (cache.nextLink !== undefined || cache.fullyLoaded)
  const nextLink = keepCachePaging ? cache.nextLink : page.nextLink
  const fullyLoaded = keepCachePaging ? cache.fullyLoaded : page.nextLink === undefined
  const prevCursor = state.messageCursorByConvo[conv]
  const nextCursor =
    prevCursor === undefined
      ? Math.max(0, merged.length - 1)
      : Math.min(prevCursor, Math.max(0, merged.length - 1))

  // Build the patch key by key, omitting anything that did not actually
  // change. Store.set compares by reference, so an unconditional spread here
  // reads as a change and notifies every listener even on an identical poll.
  const patch: Partial<AccountSlice> = {}

  // An older-page load in flight owns loadingOlder; a head poll must not
  // release it, or a second load starts and the two race on the cursor.
  const loadingOlder = cache?.loadingOlder ?? false
  const cacheUnchanged =
    cache !== undefined &&
    cache.messages === merged &&
    cache.nextLink === nextLink &&
    cache.fullyLoaded === fullyLoaded &&
    cache.error === undefined
  if (!cacheUnchanged) {
    patch.messageCacheByConvo = {
      ...state.messageCacheByConvo,
      [conv]: {
        ...(cache ?? emptyMessageCache()),
        messages: merged,
        nextLink,
        loadingOlder,
        fullyLoaded,
        error: undefined,
      },
    }
  }

  if (state.messagesByConvo[conv] !== merged) {
    patch.messagesByConvo = { ...state.messagesByConvo, [conv]: merged }
  }

  if (prevCursor !== nextCursor) {
    patch.messageCursorByConvo = { ...state.messageCursorByConvo, [conv]: nextCursor }
  }

  // Already identity-preserving on a no-op.
  const nextNames = indexNamesFromMessages(state.nameByUserId, merged)
  if (nextNames !== state.nameByUserId) patch.nameByUserId = nextNames

  if (focus.kind === 'chat') {
    const nextUnread = markChatRead(state.unreadByChatId, focus.chatId, newestMessageId(merged))
    if (nextUnread !== state.unreadByChatId) patch.unreadByChatId = nextUnread
  }
  return patch
}
