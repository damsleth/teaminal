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

import {
  getChat,
  listChats,
  listMessages,
  listMessagesNextPage,
  listMessagesPage,
} from '../graph/chats'
import { GraphError, RateLimitError } from '../graph/client'
import { getMyPresence } from '../graph/presence'
import {
  listChannelMessagesNextPage,
  listChannelMessagesPage,
  listChannels,
  listJoinedTeams,
} from '../graph/teams'
import type { Channel, Chat, ChatMessage } from '../types'
import {
  type AppState,
  type ConvKey,
  type Focus,
  bumpChatMention,
  cacheMessagesFromLegacy,
  emptyMessageCache,
  focusKey,
  markChatRead,
  markChatUnread,
  seedChatActivity,
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
  // 'active' fires when the user is actively viewing the conv whose poll
  // returned a new mention. 'list-diff' fires from the list loop's cross-
  // chat scan when a non-active 1:1/group chat got a new mention.
  source: 'active' | 'list-diff'
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
  // Wake the active and list sleepers immediately so the next iteration
  // runs without waiting out the current interval. Useful when the user
  // hits a manual-refresh key.
  refresh: () => void
  // Fetch one older page for the currently-focused conversation, if any.
  loadOlderMessages: () => Promise<LoadOlderMessagesResult>
}

export type LoadOlderMessagesResult = {
  conv: ConvKey | null
  added: number
  fullyLoaded: boolean
  anchorMessageId?: string
  error?: Error
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

// Merge a fresh server page with the local cache without dropping older
// pages or optimistic sends. Server-confirmed messages take precedence
// wherever ids overlap.
export function mergeWithOptimistic(existing: ChatMessage[], server: ChatMessage[]): ChatMessage[] {
  return mergeChronological(existing, server)
}

function messageTime(msg: ChatMessage): number {
  const parsed = Date.parse(msg.createdDateTime)
  return Number.isFinite(parsed) ? parsed : 0
}

function mergeChronological(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const msg of existing) byId.set(msg.id, msg)
  for (const msg of incoming) byId.set(msg.id, msg)
  return Array.from(byId.values()).sort((a, b) => messageTime(a) - messageTime(b))
}

function countNewMessages(existing: ChatMessage[], incoming: ChatMessage[]): number {
  const ids = new Set(existing.map((m) => m.id))
  let count = 0
  for (const msg of incoming) {
    if (!ids.has(msg.id)) count++
  }
  return count
}

type MessagesPage = {
  messages: ChatMessage[]
  nextLink?: string
}

function newestMessageId(messages: ChatMessage[]): string | undefined {
  return messages[messages.length - 1]?.id
}

function mergeActivePagePatch(
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

// /chats does not return members on the bulk list call ($expand=members is
// capped at 25 with a different shape). Each list-poll iteration would
// therefore overwrite previously-hydrated members with undefined and chat
// labels would flip back to "(1:1)". Carry forward members from the prior
// store snapshot so labels stay stable.
export function mergeChatMembers(prev: Chat[], next: Chat[]): Chat[] {
  if (prev.length === 0) return next
  const prevById = new Map(prev.map((c) => [c.id, c]))
  return next.map((c) => {
    const p = prevById.get(c.id)
    if (p?.members && p.members.length > 0 && (!c.members || c.members.length === 0)) {
      return { ...c, members: p.members }
    }
    return c
  })
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

async function fetchActiveMessages(focus: Focus, signal: AbortSignal): Promise<MessagesPage> {
  if (focus.kind === 'chat') {
    return listMessagesPage(focus.chatId, { signal })
  }
  if (focus.kind === 'channel') {
    return listChannelMessagesPage(focus.teamId, focus.channelId, { signal })
  }
  return { messages: [] }
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

  async function loadOlderMessages(): Promise<LoadOlderMessagesResult> {
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
      reportError('active', error)
      return { conv, added: 0, fullyLoaded: false, anchorMessageId, error }
    }
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
        const page = await fetchActiveMessages(focus, activeAbort.signal)
        const messages = page.messages
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
            ...mergeActivePagePatch(s, conv, page, focus),
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

  // After a successful list-poll, walk chats whose lastMessagePreview.id
  // changed since the previous poll and (a) the new message is from a
  // non-self sender, (b) the chat is not the currently active focus.
  // For each such chat, fetch the top 5 messages, find the one matching
  // the new preview id, and fire onMention if it has a mention to me.
  // Concurrency capped at 5 in flight so this does not pile up against
  // Graph throttles.
  async function runCrossChatMentionPass(
    chats: Chat[],
    myId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const activeKey = focusKey(store.get().focus)
    const candidates: Chat[] = []
    let nextUnread = store.get().unreadByChatId
    for (const chat of chats) {
      const curId = chat.lastMessagePreview?.id
      const prevId = prevPreviewIds.get(chat.id)
      if (curId) prevPreviewIds.set(chat.id, curId)
      if (!curId) continue
      if (curId === prevId) continue
      if (prevId === undefined) continue // first time seeing this chat after seed phase
      const senderId = chat.lastMessagePreview?.from?.user?.id
      const conv: ConvKey = `chat:${chat.id}`
      if (conv === activeKey || senderId === myId) {
        nextUnread = markChatRead(nextUnread, chat.id, curId)
        continue
      }
      nextUnread = markChatUnread(nextUnread, chat)
      candidates.push(chat)
    }
    if (nextUnread !== store.get().unreadByChatId) {
      store.set({ unreadByChatId: nextUnread })
    }
    if (candidates.length === 0) return
    const CONCURRENCY = 5
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY)
      await Promise.all(
        batch.map((chat) =>
          probeChatForMention(chat, myId, signal).catch((err) => {
            if (!isAbortError(err)) reportError('list', err)
          }),
        ),
      )
      if (signal.aborted) return
    }
  }

  async function probeChatForMention(chat: Chat, myId: string, signal: AbortSignal): Promise<void> {
    const conv: ConvKey = `chat:${chat.id}`
    const targetId = chat.lastMessagePreview?.id
    if (!targetId) return
    const messages = await listMessages(chat.id, { top: 5, signal })
    const seenSet = seen.get(conv) ?? new Set<string>()
    const target = messages.find((m) => m.id === targetId)
    const wasUnseen = target && !seenSet.has(target.id)
    // Seed the seen-set with everything we just fetched so a subsequent
    // active-loop open doesn't re-notify these IDs as "new".
    for (const m of messages) seenSet.add(m.id)
    seen.set(conv, seenSet)
    if (target && wasUnseen && shouldNotifyMention(target, myId)) {
      store.set((s) => ({ unreadByChatId: bumpChatMention(s.unreadByChatId, chat.id) }))
      onMention?.({ conv, message: target, source: 'list-diff' })
    }
  }

  // Per-chat snapshot of the last seen lastMessagePreview.id, used to
  // detect new activity in non-active chats between list polls. Seeded
  // on the very first list poll without firing any notifications.
  const prevPreviewIds = new Map<string, string>()
  let firstListPoll = true

  // Tracks chat IDs we've already issued a getChat($expand=members) call
  // for; once a chat is hydrated its members are carried forward via
  // mergeChatMembers, so re-fetching on every list poll is wasted work.
  const memberHydrated = new Set<string>()
  const hydrateAbort = new AbortController()

  // Background member hydration. /chats does not return members on the
  // bulk list; without this, every 1:1 row would render as "(1:1)" until
  // focused. Runs after each list poll, capped concurrency, no-op once
  // every chat has been seen.
  async function hydrateMissingMembers(chats: Chat[]): Promise<void> {
    const targets = chats.filter((c) => {
      if (memberHydrated.has(c.id)) return false
      if (c.topic) return false // group chat with explicit topic uses topic as label
      if (c.members && c.members.length > 0) return false
      return true
    })
    if (targets.length === 0) return
    const CONCURRENCY = 5
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      if (stopped || hydrateAbort.signal.aborted) return
      const batch = targets.slice(i, i + CONCURRENCY)
      await Promise.all(
        batch.map(async (chat) => {
          try {
            const full = await getChat(chat.id, {
              members: true,
              signal: hydrateAbort.signal,
            })
            memberHydrated.add(chat.id)
            if (full.members && full.members.length > 0) {
              store.set((s) => ({
                chats: s.chats.map((c) => (c.id === chat.id ? { ...c, members: full.members } : c)),
              }))
            }
          } catch (err) {
            if (isAbortError(err)) return
            reportError('list', err)
          }
        }),
      )
    }
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
        store.set((s) => ({
          chats: mergeChatMembers(s.chats, chats),
          teams: teamsAndChannels.teams,
          channelsByTeam: teamsAndChannels.channelsByTeam,
          conn: 'online',
          lastListPollAt: new Date(),
        }))

        // Fire-and-forget: don't block the next list-poll iteration on
        // member hydration. Concurrency-capped inside the function.
        hydrateMissingMembers(chats).catch((err) => {
          if (!isAbortError(err)) reportError('list', err)
        })

        const myId = store.get().me?.id
        const wasFirst = firstListPoll
        firstListPoll = false
        if (myId && !wasFirst) {
          await runCrossChatMentionPass(chats, myId, listAbort.signal)
        } else {
          // Seed prevPreviewIds without firing anything.
          for (const chat of chats) {
            const id = chat.lastMessagePreview?.id
            if (id) prevPreviewIds.set(chat.id, id)
          }
          store.set((s) => ({
            unreadByChatId: seedChatActivity(s.unreadByChatId, chats),
          }))
        }
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
      hydrateAbort.abort()
      activeSleeper.wake()
      listSleeper.wake()
      presenceSleeper.wake()
      await loops
    },
    refresh() {
      activeSleeper.wake()
      listSleeper.wake()
    },
    loadOlderMessages,
  }
}
