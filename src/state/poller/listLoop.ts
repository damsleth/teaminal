// Chat-list polling loop.
//
// Refreshes /chats with lastMessagePreview, joined teams, and per-team
// channel lists every `intervalMs`. Seeds the cross-chat mention pass's
// prevPreviewIds set on the first poll (no notifications); subsequent
// polls fire onMention for non-active 1:1/group chats whose
// lastMessagePreview.id moved.
//
// Member hydration is fire-and-forget: we don't block the next list
// iteration on it, but we cap concurrency inside the helper. Errors
// downgrade conn to authError / rateLimited / offline so the StatusBar
// can surface the state.

import { listChats } from '../../graph/chats'
import { GraphError, RateLimitError } from '../../graph/client'
import { recordEvent } from '../../log'
import { mergeChatMembers } from './chatList'
import { runCrossChatMentionPass } from './crossChatMentions'
import { fetchTeamsAndChannels } from './teamsAndChannels'
import { hydrateMissingMembers } from './hydrateMembers'
import { backoff, isAbortError, jitter } from './intervals'
import type { Sleeper } from './sleeper'
import { seedChatActivity, type AppState, type ConvKey, type Store } from '../store'
import type { MentionEvent } from '../poller'

export type ListLoopDeps = {
  store: Store<AppState>
  sleeper: Sleeper
  intervalMs: number
  seen: Map<ConvKey, Set<string>>
  // Hot-stop signal for the background member hydration; the loop
  // module does not own this so stop() can abort it independently.
  hydrateSignal: AbortSignal
  isStopped: () => boolean
  onMention?: (event: MentionEvent) => void
  reportError: (err: unknown) => void
  // Set of chat IDs already hydrated via $batch. Owned by the parent
  // poller so hardRefresh can clear it and force re-hydration of every
  // chat (otherwise unresolved "(1:1)" labels stay stale across the
  // refresh).
  memberHydrated: Set<string>
}

export function makeListLoop(deps: ListLoopDeps): () => Promise<void> {
  const {
    store,
    sleeper,
    intervalMs,
    seen,
    hydrateSignal,
    isStopped,
    onMention,
    reportError,
    memberHydrated,
  } = deps

  // Per-chat snapshot of the last seen lastMessagePreview.id.
  const prevPreviewIds = new Map<string, string>()
  let firstListPoll = true

  return async function run(): Promise<void> {
    let consecutiveErrors = 0
    while (!isStopped()) {
      const listAbort = new AbortController()
      try {
        const startedAt = Date.now()
        recordEvent('poller', 'info', 'list refresh started')
        const [chats, teamsAndChannels] = await Promise.all([
          listChats({ signal: listAbort.signal }),
          fetchTeamsAndChannels(listAbort.signal, reportError),
        ])
        const channelCount = Object.values(teamsAndChannels.channelsByTeam).reduce(
          (sum, channels) => sum + channels.length,
          0,
        )
        recordEvent('poller', 'info', 'list refresh fetched', {
          chats: chats.length,
          teams: teamsAndChannels.teams.length,
          channels: channelCount,
          durationMs: Date.now() - startedAt,
        })
        if (isStopped()) return
        store.set((s) => ({
          chats: mergeChatMembers(s.chats, chats),
          teams: teamsAndChannels.teams,
          channelsByTeam: teamsAndChannels.channelsByTeam,
          conn: 'online',
          lastListPollAt: new Date(),
        }))

        // Fire-and-forget; helper has its own concurrency cap.
        hydrateMissingMembers(
          {
            store,
            hydrated: memberHydrated,
            signal: hydrateSignal,
            isStopped,
            reportError,
          },
          chats,
        ).catch((err) => {
          if (!isAbortError(err)) reportError(err)
        })

        const myId = store.get().me?.id
        const wasFirst = firstListPoll
        firstListPoll = false
        if (myId && !wasFirst) {
          await runCrossChatMentionPass(
            { store, seen, prevPreviewIds, onMention, reportError },
            chats,
            myId,
            listAbort.signal,
          )
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
          reportError(err)
          if (err instanceof GraphError && err.status === 401) {
            store.set({ conn: 'authError' })
          } else if (err instanceof RateLimitError) {
            store.set({ conn: 'rateLimited' })
          } else {
            store.set({ conn: 'offline' })
          }
          recordEvent('poller', 'warn', 'list refresh failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      await sleeper.sleep(jitter(backoff(intervalMs, consecutiveErrors)))
    }
  }
}
