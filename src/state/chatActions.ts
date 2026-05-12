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
  getChat,
  searchChatUsers as searchChatUsersGraph,
  sendMessage as sendMessageGraph,
} from '../graph/chats'
import { searchExternalUsers as searchExternalUsersGraph } from '../graph/teamsExternalSearch'
import { resolveFederatedEquivalentConversationId } from '../graph/teamsFederation'
import {
  postChannelReply as postChannelReplyGraph,
  sendChannelMessage as sendChannelMessageGraph,
} from '../graph/teams'
import { recordEvent } from '../log'
import type { Chat, ChatMessage, DirectoryUser } from '../types'
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
