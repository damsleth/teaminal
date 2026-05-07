// Active-conversation polling loop.
//
// Re-fetches messages for the currently-focused chat or channel every
// `intervalMs`. Seeds the seen-message-ID set on first fetch (no
// notifications); subsequent fetches diff against the set and fire
// onMention for newly-seen mentions of `me` from non-self senders.
//
// stillSame guards apply-on-stale-focus: if the user moves focus while
// we were in flight, we drop the result rather than poison the next
// conversation's view with the previous one's messages.

import { listMessagesPage } from '../../graph/chats'
import { listChannelMessagesPage, listChannelRepliesPage } from '../../graph/teams'
import { recordEvent } from '../../log'
import type { ChatMessage } from '../../types'
import { focusKey, type AppState, type ConvKey, type Focus, type Store } from '../store'
import type { MentionEvent } from '../poller'
import { scheduleReplyCountFetch } from '../threadMeta'
import { backoff, isAbortError, jitter } from './intervals'
import { shouldNotifyMention } from './mentions'
import { mergeActivePagePatch, type MessagesPage } from './pagePatch'
import type { Sleeper } from './sleeper'

export type ActiveLoopDeps = {
  store: Store<AppState>
  sleeper: Sleeper
  intervalMs: number
  // seen-message-ID set, shared across loops (the cross-chat mention
  // pass also seeds it so a later active-loop open doesn't re-notify).
  seen: Map<ConvKey, Set<string>>
  // Set/cleared per iteration so stop() and focus-change subscribers
  // can abort the in-flight fetch via abort().
  setActiveAbort: (c: AbortController | null) => void
  isStopped: () => boolean
  onMention?: (event: MentionEvent) => void
  reportError: (err: unknown) => void
}

async function fetchActiveMessages(focus: Focus, signal: AbortSignal): Promise<MessagesPage> {
  if (focus.kind === 'chat') {
    return listMessagesPage(focus.chatId, { signal })
  }
  if (focus.kind === 'channel') {
    return listChannelMessagesPage(focus.teamId, focus.channelId, { signal })
  }
  if (focus.kind === 'thread') {
    return listChannelRepliesPage(focus.teamId, focus.channelId, focus.rootId, { signal })
  }
  return { messages: [] }
}

export function makeActiveLoop(deps: ActiveLoopDeps): () => Promise<void> {
  const { store, sleeper, intervalMs, seen, setActiveAbort, isStopped, onMention, reportError } =
    deps

  return async function run(): Promise<void> {
    let consecutiveErrors = 0
    while (!isStopped()) {
      const focus = store.get().focus
      const conv = focusKey(focus)
      if (!conv) {
        await sleeper.sleep(jitter(intervalMs))
        continue
      }
      const ctrl = new AbortController()
      setActiveAbort(ctrl)
      try {
        const startedAt = Date.now()
        recordEvent('poller', 'info', 'active refresh started', { conv })
        const page = await fetchActiveMessages(focus, ctrl.signal)
        const messages = page.messages
        recordEvent('poller', 'info', 'active refresh fetched', {
          conv,
          messages: messages.length,
          durationMs: Date.now() - startedAt,
        })
        if (isStopped()) return
        // Only apply if the focus is still on the same conversation.
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
          // Opportunistic reply-count badge fetch for channel roots.
          // Throttled per-channel inside scheduleReplyCountFetch; safe
          // to call on every successful channel poll.
          if (focus.kind === 'channel' && messages.length > 0) {
            void scheduleReplyCountFetch({
              store,
              teamId: focus.teamId,
              channelId: focus.channelId,
              rootMessages: messages,
            })
          }
        }
        consecutiveErrors = 0
      } catch (err) {
        if (!isAbortError(err)) {
          consecutiveErrors++
          reportError(err)
          recordEvent('poller', 'warn', 'active refresh failed', {
            conv,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        setActiveAbort(null)
      }
      await sleeper.sleep(jitter(backoff(intervalMs, consecutiveErrors)))
    }
  }
}
