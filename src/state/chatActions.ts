// One-shot chat actions wrapped at the state layer.
//
// These are user-triggered imperative actions (create chat, hydrate a
// federation-resolved chat) that need to call Graph and surface a
// result to the UI. They wrap the underlying src/graph calls so that
// UI components depend only on src/state, preserving the
// bin/ -> ui/ -> state/ -> graph/ direction.
//
// Freshness polling lives in src/state/poller.ts; this module is the
// imperative-action counterpart. Both modules sit in state/ for the
// same reason: they own the graph call sites for their lane.

import {
  createOneOnOneChat as createOneOnOneChatGraph,
  hideChat as hideChatGraph,
  editMessage as editMessageGraph,
  getChat,
  searchChatUsers as searchChatUsersGraph,
  sendMessage as sendMessageGraph,
  setReaction as setReactionGraph,
  softDeleteMessage as softDeleteMessageGraph,
  unsetReaction as unsetReactionGraph,
} from '../graph/chats'
import {
  searchMessages as searchMessagesGraph,
  type SearchMessagesOpts,
} from '../graph/messageSearch'
import { searchExternalUsers as searchExternalUsersGraph } from '../graph/teamsExternalSearch'
import { resolveFederatedEquivalentConversationId } from '../graph/teamsFederation'
import {
  postChannelReply as postChannelReplyGraph,
  sendChannelMessage as sendChannelMessageGraph,
} from '../graph/teams'
import type { GraphClient } from '../graph/client'
import { recordEvent } from '../log'
import type { Chat, ChatMessage, ChatMessageSearchHit, DirectoryUser, IdentityUser } from '../types'
import {
  applyDelete,
  applyEdit,
  applyReaction,
  hasReactionType,
  removeReactionType,
} from './messageMutations'
import {
  focusKey,
  type AppState,
  type FocusChannel,
  type FocusChat,
  type FocusThread,
  type Store,
} from './store'

/**
 * Look up the federated-equivalent conversation id for a 1:1 chat, if
 * one exists. Returns null on lookup failure (logged) or when no
 * federated peer exists; never throws.
 */
export async function resolveFederatedChatId(
  client: GraphClient,
  selfId: string,
  otherUserId: string,
): Promise<string | null> {
  try {
    return await resolveFederatedEquivalentConversationId(selfId, otherUserId, {
      account: client.ctx.account,
    })
  } catch (err) {
    recordEvent(
      'graph',
      'warn',
      `federated equivalent lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/**
 * Resolve a chat by id, preferring the in-store copy and falling back
 * to a Graph hydrate. Synthesises a minimal placeholder on Graph
 * failure so the caller can still focus the chat - the poller will
 * fill in the real details on the next list refresh.
 */
export async function materializeChat(
  client: GraphClient,
  store: Store<AppState>,
  chatId: string,
): Promise<Chat> {
  const local = store.get().chats.find((c) => c.id === chatId)
  if (local) return local
  return getChat(client, chatId, { members: true }).catch((err) => {
    recordEvent(
      'graph',
      'warn',
      `federated canonical chat hydrate failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return {
      id: chatId,
      chatType: 'oneOnOne' as const,
      createdDateTime: new Date().toISOString(),
    }
  })
}

/** Create a 1:1 chat with another user. Surfaces Graph errors to the caller. */
export async function createOneOnOneChat(
  client: GraphClient,
  selfId: string,
  otherUserId: string,
): Promise<Chat> {
  return createOneOnOneChatGraph(client, selfId, otherUserId)
}

/** Hydrate a chat from Graph with members expanded. Throws on Graph errors. */
export async function hydrateChat(client: GraphClient, chatId: string): Promise<Chat> {
  return getChat(client, chatId, { members: true })
}

function makeTempId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export type SendResult = { ok: true } | { ok: false; error: string }

/**
 * Send `content` to a chat, channel or thread with an optimistic row: the
 * message appears at once (marked sending) and its draft is cleared, then the
 * server copy replaces it, or on failure it is marked failed and the text goes
 * back into the draft. Writes after the network call are dropped when
 * `isStale()` reports the account changed underneath the send.
 */
export async function sendMessage(
  client: GraphClient,
  store: Store<AppState>,
  focus: FocusChat | FocusChannel | FocusThread,
  content: string,
  opts?: { isStale?: () => boolean },
): Promise<SendResult> {
  const conv = focusKey(focus)!
  const tempId = makeTempId()
  const me = store.get().me
  const optimistic: ChatMessage = {
    id: tempId,
    _tempId: tempId,
    _sending: true,
    createdDateTime: new Date().toISOString(),
    body: { contentType: 'text', content },
    from: { user: { id: me?.id || 'me', displayName: me?.displayName ?? 'Me' } },
  }
  store.set((s) => {
    const drafts = { ...s.draftsByConvo }
    delete drafts[conv]
    return {
      messagesByConvo: {
        ...s.messagesByConvo,
        [conv]: [...(s.messagesByConvo[conv] ?? []), optimistic],
      },
      draftsByConvo: drafts,
    }
  })
  const replaceTemp = (s: AppState, next: (m: ChatMessage) => ChatMessage) => ({
    ...s.messagesByConvo,
    [conv]: (s.messagesByConvo[conv] ?? []).map((m) => (m._tempId === tempId ? next(m) : m)),
  })
  try {
    const sent =
      focus.kind === 'chat'
        ? await sendMessageGraph(client, focus.chatId, content)
        : focus.kind === 'channel'
          ? await sendChannelMessageGraph(client, focus.teamId, focus.channelId, content)
          : await postChannelReplyGraph(
              client,
              focus.teamId,
              focus.channelId,
              focus.rootId,
              content,
            )
    if (!opts?.isStale?.()) store.set((s) => ({ messagesByConvo: replaceTemp(s, () => sent) }))
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'send failed'
    if (!opts?.isStale?.()) {
      store.set((s) => ({
        messagesByConvo: replaceTemp(s, (m) => ({ ...m, _sending: false, _sendError: error })),
        draftsByConvo: { ...s.draftsByConvo, [conv]: content },
      }))
    }
    return { ok: false, error }
  }
}

// --- Write path: reactions, edits, deletes (chat messages only) ---
//
// Each action optimistically mutates messagesByConvo[`chat:${chatId}`] via
// the pure reducers in ./messageMutations, fires the Graph call, and rolls
// the conversation back to its pre-action snapshot on failure (logging the
// error). Channel write support is a follow-up — the Graph paths differ.

const chatConvKey = (chatId: string): string => `chat:${chatId}`

function setConvMessages(store: Store<AppState>, convKey: string, next: ChatMessage[]): void {
  store.set((s) => ({
    messagesByConvo: { ...s.messagesByConvo, [convKey]: next },
  }))
}

// Run an optimistic mutation against a chat conversation, then a Graph call.
// Restores the snapshot if the call throws so a failed write never sticks.
async function withOptimisticChatUpdate(
  store: Store<AppState>,
  chatId: string,
  mutate: (messages: ChatMessage[]) => ChatMessage[],
  commit: () => Promise<void>,
  label: string,
): Promise<void> {
  const convKey = chatConvKey(chatId)
  const snapshot = store.get().messagesByConvo[convKey] ?? []
  setConvMessages(store, convKey, mutate(snapshot))
  try {
    await commit()
  } catch (err) {
    setConvMessages(store, convKey, snapshot)
    recordEvent(
      'graph',
      'warn',
      `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    throw err
  }
}

/**
 * Toggle the current user's reaction of the given type on a chat message.
 * Per-type semantics: if the user already has THAT exact type, unset just
 * that type; otherwise add it as an ADDITIONAL reaction (Teams allows
 * multiple distinct reactions per user per message). Picking a new emoji
 * thus adds to the user's reactions while picking the same emoji removes it.
 */
export async function toggleReaction(
  client: GraphClient,
  store: Store<AppState>,
  chatId: string,
  messageId: string,
  reactionType: string,
  me: IdentityUser,
): Promise<void> {
  const convKey = chatConvKey(chatId)
  const message = (store.get().messagesByConvo[convKey] ?? []).find((m) => m.id === messageId)
  const removing = message ? hasReactionType(message, me.id, reactionType) : false

  await withOptimisticChatUpdate(
    store,
    chatId,
    (messages) =>
      removing
        ? removeReactionType(messages, messageId, me.id, reactionType)
        : applyReaction(messages, messageId, reactionType, me),
    () =>
      removing
        ? unsetReactionGraph(client, chatId, messageId, reactionType)
        : setReactionGraph(client, chatId, messageId, reactionType),
    removing ? 'unset reaction' : 'set reaction',
  )
}

/** Edit the content of one of the user's own chat messages. */
export async function editChatMessageContent(
  client: GraphClient,
  store: Store<AppState>,
  chatId: string,
  messageId: string,
  content: string,
): Promise<void> {
  const trimmed = content.trim()
  if (!trimmed) return
  await withOptimisticChatUpdate(
    store,
    chatId,
    (messages) => applyEdit(messages, messageId, trimmed, new Date().toISOString()),
    () => editMessageGraph(client, chatId, messageId, trimmed),
    'edit message',
  )
}

/** Soft-delete one of the user's own chat messages (renders as a tombstone). */
export async function deleteChatMessageById(
  client: GraphClient,
  store: Store<AppState>,
  chatId: string,
  messageId: string,
): Promise<void> {
  await withOptimisticChatUpdate(
    store,
    chatId,
    (messages) => applyDelete(messages, messageId, new Date().toISOString()),
    () => softDeleteMessageGraph(client, chatId, messageId),
    'delete message',
  )
}

/**
 * Teams' "Delete chat" on a conversation: drop it from the list right
 * away, then hide it server-side. On failure the chat comes back and the
 * error is logged - the poller would restore it on the next list pass
 * anyway, so re-inserting locally just avoids the flicker of waiting.
 */
export async function deleteChatById(
  client: GraphClient,
  store: Store<AppState>,
  chatId: string,
): Promise<void> {
  const before = store.get().chats
  const removed = before.find((c) => c.id === chatId)
  if (!removed) return
  const selfId = store.get().me?.id
  if (!selfId) throw new Error('cannot delete chat before /me is loaded')
  store.set((s) => ({
    chats: s.chats.filter((c) => c.id !== chatId),
    ...(s.focus.kind === 'chat' && s.focus.chatId === chatId
      ? { focus: { kind: 'list' as const }, inputZone: 'list' as const }
      : {}),
  }))
  try {
    await hideChatGraph(client, chatId, selfId)
    recordEvent('graph', 'info', `deleted chat ${chatId}`)
  } catch (err) {
    store.set((s) => (s.chats.some((c) => c.id === chatId) ? {} : { chats: [removed, ...s.chats] }))
    recordEvent(
      'graph',
      'error',
      `delete chat failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    throw err
  }
}

/** Internal-tenant directory search for the new-chat prompt. */
export async function searchChatUsers(
  client: GraphClient,
  query: string,
  opts?: { top?: number; signal?: AbortSignal },
): Promise<DirectoryUser[]> {
  return searchChatUsersGraph(client, query, opts)
}

/** External / federated directory search for the new-chat prompt. */
export async function searchExternalUsers(
  client: GraphClient,
  query: string,
  opts?: { top?: number; signal?: AbortSignal },
): Promise<DirectoryUser[]> {
  return searchExternalUsersGraph(query, { ...opts, account: client.ctx.account })
}

/** Tenant-wide server-side message search (Microsoft Search API). */
export async function searchAllMessages(
  client: GraphClient,
  query: string,
  opts?: SearchMessagesOpts,
): Promise<ChatMessageSearchHit[]> {
  return searchMessagesGraph(client, query, opts)
}
