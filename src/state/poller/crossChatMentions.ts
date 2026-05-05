// Cross-chat mention pass.
//
// After each successful list-poll, walk the chats whose
// lastMessagePreview.id changed since the previous poll. For each one
// that's (a) from a non-self sender and (b) not the currently-active
// focus, fetch the top 5 messages, find the one matching the new
// preview id, and fire onMention if it has a mention to me.
//
// The seen-message-ID set is also seeded for these chats so a later
// active-loop open does not re-notify the same IDs.
//
// Concurrency-capped at 5 in flight to bound cost against Graph
// throttles when many chats change between polls.

import { listMessages } from '../../graph/chats'
import type { Chat } from '../../types'
import {
  bumpChatMention,
  focusKey,
  markChatRead,
  markChatUnread,
  type AppState,
  type ConvKey,
  type Store,
} from '../store'
import { isAbortError } from './intervals'
import { shouldNotifyMention } from './mentions'
import type { MentionEvent } from '../poller'

const PROBE_TOP = 5
const CONCURRENCY = 5

export type CrossChatMentionDeps = {
  store: Store<AppState>
  // Seen-message-ID set keyed by ConvKey, shared with the active loop.
  // Mutated to add IDs we just fetched as a side effect.
  seen: Map<ConvKey, Set<string>>
  // Per-chat snapshot of the last seen lastMessagePreview.id, mutated
  // here as we walk the chat list.
  prevPreviewIds: Map<string, string>
  onMention?: (event: MentionEvent) => void
  reportError: (err: unknown) => void
}

export async function runCrossChatMentionPass(
  deps: CrossChatMentionDeps,
  chats: Chat[],
  myId: string,
  signal: AbortSignal,
): Promise<void> {
  const { store, prevPreviewIds } = deps
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
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map((chat) =>
        probeChatForMention(deps, chat, myId, signal).catch((err) => {
          if (!isAbortError(err)) deps.reportError(err)
        }),
      ),
    )
    if (signal.aborted) return
  }
}

async function probeChatForMention(
  deps: CrossChatMentionDeps,
  chat: Chat,
  myId: string,
  signal: AbortSignal,
): Promise<void> {
  const { store, seen, onMention } = deps
  const conv: ConvKey = `chat:${chat.id}`
  const targetId = chat.lastMessagePreview?.id
  if (!targetId) return
  const messages = await listMessages(chat.id, { top: PROBE_TOP, signal })
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
