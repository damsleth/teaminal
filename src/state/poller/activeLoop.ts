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
import { GraphError } from '../../graph/client'
import { listChannelMessagesPage, listChannelRepliesPage } from '../../graph/teams'
import { recordEvent, isDebugEnabled } from '../../log'
import { logMessageImageShape } from './imageDebug'
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

  // Per-conv "this endpoint refuses us" latch. Meeting chats and other
  // conversations the FOCI delegated token lacks scope for return 403
  // on every /chats/{id}/messages call. Without a latch the active loop
  // re-fires that 403 every interval and floods the event log. Once
  // latched, we skip the fetch entirely until focus moves to a chat
  // that isn't blocked - re-focusing the blocked chat will not retry
  // automatically, since the scope state is sticky for the session.
  const blocked = new Set<ConvKey>()

  return async function run(): Promise<void> {
    let consecutiveErrors = 0
    while (!isStopped()) {
      const focus = store.get().focus
      const conv = focusKey(focus)
      if (!conv) {
        await sleeper.sleep(jitter(intervalMs))
        continue
      }
      if (blocked.has(conv)) {
        await sleeper.sleep(jitter(intervalMs))
        continue
      }
      const ctrl = new AbortController()
      setActiveAbort(ctrl)
      try {
        const startedAt = Date.now()
        recordEvent('poller', 'debug', 'active refresh started', { conv })
        const page = await fetchActiveMessages(focus, ctrl.signal)
        const messages = page.messages
        recordEvent('poller', 'debug', 'active refresh fetched', {
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
            if (isDebugEnabled()) logMessageImageShape(msg)
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
          const is403 = err instanceof GraphError && err.status === 403
          if (is403) {
            // Sticky scope failure (e.g. meeting chats under FOCI). Log
            // once, latch, stop re-polling this conv. The chat stays in
            // its loading state - we deliberately don't write an empty
            // page because that would falsely claim "no messages" when
            // the truth is "the tenant's policy hides them from us".
            blocked.add(conv)
            recordEvent('poller', 'warn', 'active refresh blocked (403, will not retry)', {
              conv,
              error: err instanceof Error ? err.message : String(err),
            })
          } else {
            recordEvent('poller', 'warn', 'active refresh failed', {
              conv,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } finally {
        setActiveAbort(null)
      }
      await sleeper.sleep(jitter(backoff(intervalMs, consecutiveErrors)))
    }
  }
}
