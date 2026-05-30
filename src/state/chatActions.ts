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
import { recordEvent } from '../log'
import type { Chat, ChatMessage, ChatMessageSearchHit, DirectoryUser, IdentityUser } from '../types'
import {
  applyDelete,
  applyEdit,
  applyReaction,
  hasReactionType,
  removeReactionType,
} from './messageMutations'
import type { AppState, Store } from './store'

/**
 * Look up the federated-equivalent conversation id for a 1:1 chat, if
 * one exists. Returns null on lookup failure (logged) or when no
 * federated peer exists; never throws.
 */
export async function resolveFederatedChatId(
  selfId: string,
  otherUserId: string,
): Promise<string | null> {
  try {
    return await resolveFederatedEquivalentConversationId(selfId, otherUserId)
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
export async function materializeChat(store: Store<AppState>, chatId: string): Promise<Chat> {
  const local = store.get().chats.find((c) => c.id === chatId)
  if (local) return local
  return getChat(chatId, { members: true }).catch((err) => {
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
export async function createOneOnOneChat(selfId: string, otherUserId: string): Promise<Chat> {
  return createOneOnOneChatGraph(selfId, otherUserId)
}

/** Hydrate a chat from Graph with members expanded. Throws on Graph errors. */
export async function hydrateChat(chatId: string): Promise<Chat> {
  return getChat(chatId, { members: true })
}

/** Send a message to a 1:1 / group chat. */
export async function sendChatMessage(
  chatId: string,
  content: string,
  opts?: { signal?: AbortSignal },
): Promise<ChatMessage> {
  return sendMessageGraph(chatId, content, opts)
}

/** Send a top-level message to a channel. */
export async function sendChannelMessage(
  teamId: string,
  channelId: string,
  content: string,
  opts?: { signal?: AbortSignal },
): ReturnType<typeof sendChannelMessageGraph> {
  return sendChannelMessageGraph(teamId, channelId, content, opts)
}

/** Post a reply to a channel thread. */
export async function postChannelReply(
  teamId: string,
  channelId: string,
  rootId: string,
  content: string,
  opts?: { signal?: AbortSignal },
): ReturnType<typeof postChannelReplyGraph> {
  return postChannelReplyGraph(teamId, channelId, rootId, content, opts)
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
        ? unsetReactionGraph(chatId, messageId, reactionType)
        : setReactionGraph(chatId, messageId, reactionType),
    removing ? 'unset reaction' : 'set reaction',
  )
}

/** Edit the content of one of the user's own chat messages. */
export async function editChatMessageContent(
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
    () => editMessageGraph(chatId, messageId, trimmed),
    'edit message',
  )
}

/** Soft-delete one of the user's own chat messages (renders as a tombstone). */
export async function deleteChatMessageById(
  store: Store<AppState>,
  chatId: string,
  messageId: string,
): Promise<void> {
  await withOptimisticChatUpdate(
    store,
    chatId,
    (messages) => applyDelete(messages, messageId, new Date().toISOString()),
    () => softDeleteMessageGraph(chatId, messageId),
    'delete message',
  )
}

/** Internal-tenant directory search for the new-chat prompt. */
export async function searchChatUsers(
  query: string,
  opts?: { top?: number; signal?: AbortSignal },
): Promise<DirectoryUser[]> {
  return searchChatUsersGraph(query, opts)
}

/** External / federated directory search for the new-chat prompt. */
export async function searchExternalUsers(
  query: string,
  opts?: { top?: number; signal?: AbortSignal },
): Promise<DirectoryUser[]> {
  return searchExternalUsersGraph(query, opts)
}

/** Tenant-wide server-side message search (Microsoft Search API). */
export async function searchAllMessages(
  query: string,
  opts?: SearchMessagesOpts,
): Promise<ChatMessageSearchHit[]> {
  return searchMessagesGraph(query, opts)
}
