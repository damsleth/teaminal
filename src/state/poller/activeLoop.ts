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

import type { AccountStore } from '../accountStore'
import { listMessagesPage } from '../../graph/chats'
import { GraphError, type GraphClient } from '../../graph/client'
import { listChannelMessagesPage, listChannelRepliesPage } from '../../graph/teams'
import { recordEvent, isDebugEnabled } from '../../log'
import { logMessageImageShape } from './imageDebug'
import type { ChatMessage } from '../../types'
import { bumpChatMention, focusKey, type ConvKey, type Focus } from '../store'
import { visibleConvKeys } from '../panes'
import type { MentionEvent } from '../poller'
import { backoff, isAbortError, jitter } from './intervals'
import { notifyKind, type NotifyKind } from './mentions'
import { mergeActivePagePatch, type MessagesPage } from './pagePatch'
import type { Sleeper } from './sleeper'

export type ActiveLoopDeps = {
  store: AccountStore
  // The conversation this loop polls, read at the loop head and again by the
  // stale-completion guard after the fetch.
  target: () => Focus
  // Bound Graph client for this session's account.
  getClient: () => GraphClient
  sleeper: Sleeper
  intervalMs: number | (() => number)
  // seen-message-ID set, shared across loops (the cross-chat mention
  // pass also seeds it so a later active-loop open doesn't re-notify).
  seen: Map<ConvKey, Set<string>>
  // Conversations whose fetch returned 403, skipped for the session. Pass one
  // set to every loop of a session so a blocked conversation stays blocked
  // in either pane. Default: this loop's own.
  blocked?: Set<ConvKey>
  // Other conversations whose seen sets hold this one's messages too (a
  // channel and its thread in the two panes): a message new here is recorded
  // there, and one already seen there is not notified again.
  overlapKeys?: (focus: Focus) => ConvKey[]
  // Set/cleared per iteration so stop() and focus-change subscribers
  // can abort the in-flight fetch via abort().
  setActiveAbort: (c: AbortController | null) => void
  isStopped: () => boolean
  onMention?: (event: MentionEvent) => void
  reportError: (err: unknown) => void
}

async function fetchActiveMessages(
  client: GraphClient,
  focus: Focus,
  signal: AbortSignal,
): Promise<MessagesPage> {
  if (focus.kind === 'chat') {
    return listMessagesPage(client, focus.chatId, { signal })
  }
  if (focus.kind === 'channel') {
    return listChannelMessagesPage(client, focus.teamId, focus.channelId, { signal })
  }
  if (focus.kind === 'thread') {
    return listChannelRepliesPage(client, focus.teamId, focus.channelId, focus.rootId, { signal })
  }
  return { messages: [] }
}

// Message ids already handled for notification, per shared seen map (one per
// session): see the overlap note in the loop.
const notifiedBy = new WeakMap<object, Set<string>>()

export function makeActiveLoop(deps: ActiveLoopDeps): () => Promise<void> {
  const {
    store,
    target,
    sleeper,
    intervalMs,
    seen,
    setActiveAbort,
    isStopped,
    onMention,
    reportError,
  } = deps
  const getIntervalMs = typeof intervalMs === 'function' ? intervalMs : () => intervalMs

  // Per-conv "this endpoint refuses us" latch. Meeting chats and other
  // conversations the FOCI delegated token lacks scope for return 403
  // on every /chats/{id}/messages call. Without a latch the active loop
  // re-fires that 403 every interval and floods the event log. Once
  // latched, we skip the fetch entirely until focus moves to a chat
  // that isn't blocked - re-focusing the blocked chat will not retry
  // automatically, since the scope state is sticky for the session.
  const blocked = deps.blocked ?? new Set<ConvKey>()

  return async function run(): Promise<void> {
    let consecutiveErrors = 0
    while (!isStopped()) {
      const focus = target()
      const conv = focusKey(focus)
      if (!conv) {
        await sleeper.sleep(jitter(getIntervalMs()))
        continue
      }
      if (blocked.has(conv)) {
        await sleeper.sleep(jitter(getIntervalMs()))
        continue
      }
      const ctrl = new AbortController()
      setActiveAbort(ctrl)
      try {
        const startedAt = Date.now()
        recordEvent('poller', 'debug', 'active refresh started', { conv })
        const page = await fetchActiveMessages(deps.getClient(), focus, ctrl.signal)
        const messages = page.messages
        recordEvent('poller', 'debug', 'active refresh fetched', {
          conv,
          messages: messages.length,
          durationMs: Date.now() - startedAt,
        })
        if (isStopped()) return
        // Only apply if the target is still the same conversation, and the
        // fetch was not cancelled meanwhile (a close-and-reopen of the same
        // conversation, a hard refresh).
        const stillSame = !ctrl.signal.aborted && focusKey(target()) === conv
        if (stillSame) {
          const isFirst = !seen.has(conv)
          const seenSet = seen.get(conv) ?? new Set<string>()
          const s0 = store.get()
          const myId = s0.me?.id
          const chatType =
            focus.kind === 'chat'
              ? s0.chats.find((c) => c.id === focus.chatId)?.chatType
              : undefined
          const toNotify: Array<{ msg: ChatMessage; kind: NotifyKind }> = []
          // A channel and its thread side by side both see a new reply.
          // Whichever loop notifies first records the id here, so the other
          // skips it. Not the other's seen-set: that also holds ids it only
          // seeded on its first fetch, which nobody was notified about.
          const overlapping = !isFirst && (deps.overlapKeys?.(focus) ?? []).length > 0
          const notified = notifiedBy.get(seen) ?? new Set<string>()
          notifiedBy.set(seen, notified)
          for (const msg of messages) {
            if (seenSet.has(msg.id)) continue
            seenSet.add(msg.id)
            if (isDebugEnabled()) logMessageImageShape(msg)
            if (isFirst || !myId) continue
            if (overlapping) {
              if (notified.has(msg.id)) continue
              notified.add(msg.id)
            }
            const kind = notifyKind(msg, myId, chatType, s0.settings.notifyChatMessages)
            if (kind) toNotify.push({ msg, kind })
          }
          capSeen(seenSet)
          capSeen(notified)
          seen.set(conv, seenSet)
          // A conversation not on screen (a hidden passive pane) is not
          // marked read, and its new mentions count, as the cross-chat
          // probe counts them for any other chat.
          store.set((s) => {
            const viewed = visibleConvKeys(s).includes(conv)
            const patch = mergeActivePagePatch(s, conv, page, focus, viewed)
            if (viewed || focus.kind !== 'chat') return patch
            let unread = patch.unreadByChatId ?? s.unreadByChatId
            for (const { kind } of toNotify) {
              if (kind === 'mention') unread = bumpChatMention(unread, focus.chatId)
            }
            return unread === s.unreadByChatId ? patch : { ...patch, unreadByChatId: unread }
          })
          for (const { msg, kind } of toNotify) {
            onMention?.({ conv, message: msg, source: 'active', kind })
          }
          // Channel reply counts are now derived locally from the full
          // chatsvc stream in the message pane (src/state/channelThreads.ts),
          // so there's no opportunistic per-root reply fetch here anymore.
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
      await sleeper.sleep(jitter(backoff(getIntervalMs(), consecutiveErrors)))
    }
  }
}

// Seen ids per conversation are only needed for the newest page, which old
// ids never re-enter, so keep the newest SEEN_CAP (a Set keeps insertion
// order: the oldest are first).
const SEEN_CAP = 2000

export function capSeen(set: Set<string>, cap = SEEN_CAP): void {
  if (set.size <= cap) return
  let drop = set.size - cap
  for (const id of set) {
    if (drop-- <= 0) break
    set.delete(id)
  }
}
