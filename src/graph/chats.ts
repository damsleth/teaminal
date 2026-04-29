// Chat (1:1, group, meeting) endpoints.
//
// Critical invariants:
//   - $orderby=lastMessagePreview/createdDateTime desc  (NOT lastUpdatedDateTime)
//   - $top capped at 50 by Graph for /chats/{id}/messages
//   - Older-page paging uses $filter=createdDateTime lt {iso} matching the
//     $orderby property; mismatched filter+orderby returns 400
//   - Member expansion is capped at 25 so we hydrate lazily, only on
//     visible/active chats

import { graph } from './client'
import type { Chat, ChatMessage } from '../types'

type CollectionResponse<T> = { value: T[]; '@odata.nextLink'?: string }

const MESSAGES_TOP_DEFAULT = 50
const CHATS_TOP_DEFAULT = 50

export type ListChatsOpts = {
  top?: number
  signal?: AbortSignal
}

export async function listChats(opts?: ListChatsOpts): Promise<Chat[]> {
  const top = opts?.top ?? CHATS_TOP_DEFAULT
  const res = await graph<CollectionResponse<Chat>>({
    method: 'GET',
    path: '/chats',
    query: {
      $expand: 'lastMessagePreview',
      $top: top,
      $orderby: 'lastMessagePreview/createdDateTime desc',
    },
    signal: opts?.signal,
  })
  return res.value
}

export type GetChatOpts = {
  members?: boolean
  signal?: AbortSignal
}

export async function getChat(chatId: string, opts?: GetChatOpts): Promise<Chat> {
  return graph<Chat>({
    method: 'GET',
    path: `/chats/${encodeURIComponent(chatId)}`,
    query: opts?.members ? { $expand: 'members' } : undefined,
    signal: opts?.signal,
  })
}

export type ListMessagesOpts = {
  top?: number
  // ISO 8601 timestamp; returns messages strictly older than this. Pass the
  // createdDateTime of the oldest currently-rendered message to load the
  // next older page.
  beforeCreatedDateTime?: string
  signal?: AbortSignal
}

// Returns chat messages in chronological order (oldest first), so the UI
// can append in render order without re-sorting. Graph returns descending
// by createdDateTime; this helper reverses the slice before returning.
export async function listMessages(
  chatId: string,
  opts?: ListMessagesOpts,
): Promise<ChatMessage[]> {
  const query: Record<string, string | number | undefined> = {
    $top: opts?.top ?? MESSAGES_TOP_DEFAULT,
    $orderby: 'createdDateTime desc',
  }
  if (opts?.beforeCreatedDateTime) {
    query.$filter = `createdDateTime lt ${opts.beforeCreatedDateTime}`
  }
  const res = await graph<CollectionResponse<ChatMessage>>({
    method: 'GET',
    path: `/chats/${encodeURIComponent(chatId)}/messages`,
    query,
    signal: opts?.signal,
  })
  return res.value.slice().reverse()
}

export type SendMessageOpts = {
  signal?: AbortSignal
}

export async function sendMessage(
  chatId: string,
  content: string,
  opts?: SendMessageOpts,
): Promise<ChatMessage> {
  return graph<ChatMessage>({
    method: 'POST',
    path: `/chats/${encodeURIComponent(chatId)}/messages`,
    body: { body: { contentType: 'text', content } },
    signal: opts?.signal,
  })
}
