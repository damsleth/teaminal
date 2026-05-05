// Fetch one older page for the currently-focused conversation.
//
// Behavior:
//   - Refuses when nothing is focused, when the cache is mid-load, or
//     when the cache is already fullyLoaded.
//   - For channel focus without a cached @odata.nextLink, marks the
//     cache fullyLoaded and returns. (Channel paging is nextLink-only;
//     once we exhaust the cursor there's nothing more to fetch.)
//   - For chat focus, falls back to a `beforeCreatedDateTime` filter
//     when there is no nextLink but at least one cached message.
//   - Persists a `lastOlderLoad` snapshot so the UI can show "+N older
//     messages" toasts if it wants to.
//
// All store mutations go through the store seam passed in by the
// poller; this module never imports the store factory directly.

import { listMessagesNextPage, listMessagesPage } from '../../graph/chats'
import { listChannelMessagesNextPage } from '../../graph/teams'
import {
  cacheMessagesFromLegacy,
  emptyMessageCache,
  focusKey,
  type AppState,
  type ConvKey,
  type Store,
} from '../store'
import { isAbortError } from './intervals'
import { countNewMessages, mergeChronological } from './merge'
import type { MessagesPage } from './pagePatch'

export type LoadOlderMessagesResult = {
  conv: ConvKey | null
  added: number
  fullyLoaded: boolean
  anchorMessageId?: string
  error?: Error
}

export type LoadOlderDeps = {
  store: Store<AppState>
  reportError: (err: Error) => void
}

export async function loadOlderMessages(deps: LoadOlderDeps): Promise<LoadOlderMessagesResult> {
  const { store, reportError } = deps
  const focus = store.get().focus
  const conv = focusKey(focus)
  if (!conv) return { conv: null, added: 0, fullyLoaded: true }

  const initialState = store.get()
  const initialCache =
    initialState.messageCacheByConvo[conv] ??
    emptyMessageCache(initialState.messagesByConvo[conv] ?? [])
  if (initialCache.loadingOlder) {
    return { conv, added: 0, fullyLoaded: initialCache.fullyLoaded }
  }
  if (initialCache.fullyLoaded) {
    return { conv, added: 0, fullyLoaded: true }
  }

  const anchorMessageId = initialCache.messages[0]?.id

  // Channel paging is nextLink-only. Without a cursor we cannot reach
  // older messages; mark the cache exhausted so the UI stops offering
  // "Load older" on a channel that's already shown its first page.
  if (focus.kind === 'channel' && !initialCache.nextLink) {
    store.set((s) => {
      const cache = s.messageCacheByConvo[conv] ?? initialCache
      const nextCaches = {
        ...s.messageCacheByConvo,
        [conv]: { ...cache, fullyLoaded: true, loadingOlder: false },
      }
      return {
        messageCacheByConvo: nextCaches,
        messagesByConvo: {
          ...s.messagesByConvo,
          [conv]: nextCaches[conv]?.messages ?? [],
        },
      }
    })
    return { conv, added: 0, fullyLoaded: true, anchorMessageId }
  }

  // Mark loadingOlder so the UI can render a spinner. Migrate any
  // legacy in-memory cache (pre-shipping the structured cache) into
  // the new shape on first write, otherwise the patch below loses
  // everything older than the visible window.
  store.set((s) => {
    const caches =
      Object.keys(s.messageCacheByConvo).length === 0
        ? cacheMessagesFromLegacy(s.messagesByConvo)
        : s.messageCacheByConvo
    const cache = caches[conv] ?? initialCache
    return {
      messageCacheByConvo: {
        ...caches,
        [conv]: { ...cache, loadingOlder: true, error: undefined },
      },
    }
  })

  const olderAbort = new AbortController()
  try {
    const cache = store.get().messageCacheByConvo[conv] ?? initialCache
    let page: MessagesPage
    if (cache.nextLink) {
      page =
        focus.kind === 'chat'
          ? await listMessagesNextPage(cache.nextLink, { signal: olderAbort.signal })
          : await listChannelMessagesNextPage(cache.nextLink, { signal: olderAbort.signal })
    } else if (focus.kind === 'chat') {
      const oldest = cache.messages[0]
      if (!oldest) {
        page = { messages: [] }
      } else {
        page = await listMessagesPage(focus.chatId, {
          beforeCreatedDateTime: oldest.createdDateTime,
          signal: olderAbort.signal,
        })
      }
    } else {
      page = { messages: [] }
    }

    let result: LoadOlderMessagesResult = {
      conv,
      added: 0,
      fullyLoaded: true,
      anchorMessageId,
    }
    store.set((s) => {
      const current = s.messageCacheByConvo[conv] ?? initialCache
      const added = countNewMessages(current.messages, page.messages)
      const merged = mergeChronological(current.messages, page.messages)
      const fullyLoaded = page.nextLink === undefined || page.messages.length === 0
      const nextCaches = {
        ...s.messageCacheByConvo,
        [conv]: {
          ...current,
          messages: merged,
          nextLink: page.nextLink,
          loadingOlder: false,
          fullyLoaded,
          error: undefined,
          lastOlderLoad: {
            beforeFirstId: anchorMessageId,
            addedCount: added,
          },
        },
      }
      result = { conv, added, fullyLoaded, anchorMessageId }
      return {
        messageCacheByConvo: nextCaches,
        messagesByConvo: {
          ...s.messagesByConvo,
          [conv]: merged,
        },
      }
    })
    return result
  } catch (err) {
    if (isAbortError(err)) {
      return { conv, added: 0, fullyLoaded: false, anchorMessageId }
    }
    const error = err instanceof Error ? err : new Error(String(err))
    store.set((s) => {
      const current = s.messageCacheByConvo[conv] ?? initialCache
      return {
        messageCacheByConvo: {
          ...s.messageCacheByConvo,
          [conv]: {
            ...current,
            loadingOlder: false,
            error: error.message,
          },
        },
      }
    })
    reportError(error)
    return { conv, added: 0, fullyLoaded: false, anchorMessageId, error }
  }
}
