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

import type { AccountStore } from '../accountStore'
import { listMessagesNextPage, listMessagesPage } from '../../graph/chats'
import type { GraphClient } from '../../graph/client'
import { listChannelMessagesNextPage, listChannelMessagesPage } from '../../graph/teams'
import {
  cacheMessagesFromLegacy,
  emptyMessageCache,
  focusKey,
  type ConvKey,
  type Focus,
} from '../store'
import { indexNamesFromMessages } from '../nameIndex'
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
  store: AccountStore
  // The conversation to page, captured by the caller.
  focus: Focus
  getClient: () => GraphClient
  reportError: (err: Error) => void
  // Session stop signal: aborts the fetch, and a page that lands after stop
  // (account switch, shutdown) is dropped instead of written into the reset store.
  signal?: AbortSignal
}

export async function loadOlderMessages(deps: LoadOlderDeps): Promise<LoadOlderMessagesResult> {
  const { store, focus, reportError, signal } = deps
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

  try {
    const client = deps.getClient()
    const cache = store.get().messageCacheByConvo[conv] ?? initialCache
    let page: MessagesPage
    if (cache.nextLink) {
      page =
        focus.kind === 'chat'
          ? await listMessagesNextPage(client, cache.nextLink, { signal })
          : await listChannelMessagesNextPage(client, cache.nextLink, { signal })
    } else if (focus.kind === 'chat') {
      const oldest = cache.messages[0]
      if (!oldest) {
        page = { messages: [] }
      } else {
        page = await listMessagesPage(client, focus.chatId, {
          beforeCreatedDateTime: oldest.createdDateTime,
          signal,
        })
      }
    } else if (focus.kind === 'channel') {
      // Channel paging is nextLink-only. Without a cursor (e.g. the saved
      // cache was trimmed) start again from the newest page: its link walks
      // back through what's already here (merged without duplicates) and on
      // to older history. A channel with a single page comes back without a
      // link and is marked fully loaded below.
      page = await listChannelMessagesPage(client, focus.teamId, focus.channelId, { signal })
    } else {
      page = { messages: [] }
    }

    if (signal?.aborted) return { conv, added: 0, fullyLoaded: false, anchorMessageId }
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
        nameByUserId: indexNamesFromMessages(s.nameByUserId, page.messages),
      }
    })
    return result
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
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
