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

import type { AccountStore } from './accountStore'
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
import { newClientMessageId } from '../graph/teamsChatsvc'
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
import { mergeChronological } from './poller/merge'
import {
  focusKey,
  type AccountSlice,
  type AppState,
  type ConvKey,
  type FocusChannel,
  type FocusChat,
  type FocusThread,
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
  store: AccountStore,
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

// Both message maps hold the conversation's list: the UI reads
// messagesByConvo, the poller merges from messageCacheByConvo. An action
// writes both, or the next poll undoes it.
function convPatch(
  s: AppState,
  conv: ConvKey,
  next: ChatMessage[],
): Pick<AppState, 'messagesByConvo'> & Partial<Pick<AppState, 'messageCacheByConvo'>> {
  const cache = s.messageCacheByConvo[conv]
  return {
    messagesByConvo: { ...s.messagesByConvo, [conv]: next },
    ...(cache
      ? { messageCacheByConvo: { ...s.messageCacheByConvo, [conv]: { ...cache, messages: next } } }
      : {}),
  }
}

const convMessages = (s: AppState, conv: ConvKey): ChatMessage[] => s.messagesByConvo[conv] ?? []

/**
 * Send `content` to a chat, channel or thread with an optimistic row: the
 * message appears at once (marked sending) and its draft is cleared, then the
 * server copy replaces it, or on failure it is marked failed and the text goes
 * back into the draft. The row carries the send's client message id, so a
 * poll echo that lands before the POST resolves replaces it instead of
 * doubling it. Writes after the network call are dropped by the AccountStore
 * when the account changed underneath the send.
 */
export async function sendMessage(
  client: GraphClient,
  store: AccountStore,
  focus: FocusChat | FocusChannel | FocusThread,
  content: string,
): Promise<SendResult> {
  const conv = focusKey(focus)!
  const tempId = makeTempId()
  const clientMessageId = newClientMessageId()
  const rootId = focus.kind === 'thread' ? focus.rootId : undefined
  const me = store.get().me
  const optimistic: ChatMessage = {
    id: tempId,
    _tempId: tempId,
    _sending: true,
    clientMessageId,
    createdDateTime: new Date().toISOString(),
    body: { contentType: 'text', content },
    from: { user: { id: me?.id || 'me', displayName: me?.displayName ?? 'Me' } },
    ...(rootId ? { replyToId: rootId, rootMessageId: rootId } : {}),
  }
  store.set((s) => {
    const drafts = { ...s.draftsByConvo }
    delete drafts[conv]
    return {
      ...convPatch(s, conv, [...convMessages(s, conv), optimistic]),
      draftsByConvo: drafts,
    }
  })
  const opts = { clientMessageId }
  try {
    const sent =
      focus.kind === 'chat'
        ? await sendMessageGraph(client, focus.chatId, content, opts)
        : focus.kind === 'channel'
          ? await sendChannelMessageGraph(client, focus.teamId, focus.channelId, content, opts)
          : await postChannelReplyGraph(
              client,
              focus.teamId,
              focus.channelId,
              focus.rootId,
              content,
              opts,
            )
    store.set((s) => {
      const list = convMessages(s, conv)
      // The poll may already hold the server copy (same id, or same client
      // id on chatsvc); keep that one and drop the optimistic row.
      const echoed = list.some(
        (m) => !m._tempId && (m.id === sent.id || m.clientMessageId === clientMessageId),
      )
      const next = echoed
        ? list.filter((m) => m._tempId !== tempId)
        : list.map((m) => (m._tempId === tempId ? sent : m))
      const patch: Partial<AccountSlice> = convPatch(s, conv, next)
      // A thread reply also belongs to the loaded parent channel stream, where
      // the root's reply badge counts it.
      if (focus.kind === 'thread') {
        const channelConv = focusKey({
          kind: 'channel',
          teamId: focus.teamId,
          channelId: focus.channelId,
        })!
        const stream = s.messagesByConvo[channelConv]
        if (stream) {
          Object.assign(
            patch,
            convPatch(
              { ...s, ...patch } as AppState,
              channelConv,
              mergeChronological(stream, [sent]),
            ),
          )
        }
      }
      return patch
    })
    return { ok: true }
  } catch (err) {
    // An echo carrying this send's client id already replaced the optimistic
    // row: the server has the message, whatever the POST reported.
    if (
      convMessages(store.get(), conv).some(
        (m) => !m._tempId && m.clientMessageId === clientMessageId,
      )
    ) {
      return { ok: true }
    }
    const error = err instanceof Error ? err.message : 'send failed'
    // The text goes back to this conversation's own draft only, above
    // anything typed there since (never replacing it).
    store.set((s) => {
      const since = s.draftsByConvo[conv]
      return {
        ...convPatch(
          s,
          conv,
          convMessages(s, conv).map((m) =>
            m._tempId === tempId ? { ...m, _sending: false, _sendError: error } : m,
          ),
        ),
        draftsByConvo: {
          ...s.draftsByConvo,
          [conv]: since && since !== content ? `${content}\n${since}` : content,
        },
      }
    })
    return { ok: false, error }
  }
}

// --- Write path: reactions, edits, deletes (chat messages only) ---
//
// Each action optimistically patches one message in `chat:${chatId}` via the
// pure reducers in ./messageMutations, fires the Graph call, and on failure
// puts back only that message's pre-action copy (logging the error), so
// messages that arrived meanwhile survive. Channel write support is a
// follow-up — the Graph paths differ.

const chatConvKey = (chatId: string): string => `chat:${chatId}`

async function withOptimisticChatUpdate(
  store: AccountStore,
  chatId: string,
  messageId: string,
  mutate: (messages: ChatMessage[]) => ChatMessage[],
  commit: () => Promise<void>,
  label: string,
): Promise<void> {
  const conv = chatConvKey(chatId)
  const original = convMessages(store.get(), conv).find((m) => m.id === messageId)
  let optimistic: ChatMessage | undefined
  store.set((s) => {
    const next = mutate(convMessages(s, conv))
    optimistic = next.find((m) => m.id === messageId)
    return convPatch(s, conv, next)
  })
  try {
    await commit()
  } catch (err) {
    // Undo only while this operation still owns the message: a poll or a
    // later action that replaced it wins. A poll that rebuilt the row but kept
    // this reaction change (same pending stamp) still counts as owned; only
    // its reactions go back.
    const mine = optimistic
    if (original && mine && mine !== original) {
      const stamp = mine._reactionsPendingAt
      store.set((s) => {
        let changed = false
        const list = convMessages(s, conv).map((m) => {
          if (m === mine) {
            changed = true
            return original
          }
          if (stamp !== undefined && m.id === messageId && m._reactionsPendingAt === stamp) {
            changed = true
            const { _reactionsPendingAt: _, ...rest } = m
            return { ...rest, reactions: original.reactions }
          }
          return m
        })
        return changed ? convPatch(s, conv, list) : {}
      })
    }
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
  store: AccountStore,
  chatId: string,
  messageId: string,
  reactionType: string,
  me: IdentityUser,
): Promise<void> {
  const convKey = chatConvKey(chatId)
  const message = convMessages(store.get(), convKey).find((m) => m.id === messageId)
  const removing = message ? hasReactionType(message, me.id, reactionType) : false

  await withOptimisticChatUpdate(
    store,
    chatId,
    messageId,
    (messages) =>
      (removing
        ? removeReactionType(messages, messageId, me.id, reactionType)
        : applyReaction(messages, messageId, reactionType, me)
      ).map((m) => (m.id === messageId ? { ...m, _reactionsPendingAt: Date.now() } : m)),
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
  store: AccountStore,
  chatId: string,
  messageId: string,
  content: string,
): Promise<void> {
  const trimmed = content.trim()
  if (!trimmed) return
  await withOptimisticChatUpdate(
    store,
    chatId,
    messageId,
    (messages) => applyEdit(messages, messageId, trimmed, new Date().toISOString()),
    () => editMessageGraph(client, chatId, messageId, trimmed),
    'edit message',
  )
}

/** Soft-delete one of the user's own chat messages (renders as a tombstone). */
export async function deleteChatMessageById(
  client: GraphClient,
  store: AccountStore,
  chatId: string,
  messageId: string,
): Promise<void> {
  await withOptimisticChatUpdate(
    store,
    chatId,
    messageId,
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
  store: AccountStore,
  chatId: string,
): Promise<void> {
  const before = store.get().chats
  const removed = before.find((c) => c.id === chatId)
  if (!removed) return
  const selfId = store.get().me?.id
  if (!selfId) throw new Error('cannot delete chat before /me is loaded')
  // Moving focus off the deleted chat is the caller's (global UI) write.
  store.set((s) => ({ chats: s.chats.filter((c) => c.id !== chatId) }))
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
