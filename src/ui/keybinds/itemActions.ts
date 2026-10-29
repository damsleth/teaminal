// Actions on one chat-list row or one message, shared by their keys
// (listKeys / chatKeys) and the context menu, so both always do the same.

import { toggleChatUnread, type AppState, type Store } from '../../state/store'
import { htmlToText } from '../../text/html'
import type { Chat, ChatMessage } from '../../types'

const DELETE_PREVIEW_MAX = 60

export function messagePreview(m: ChatMessage): string {
  const raw = m.body?.content ?? ''
  const text =
    m.body?.contentType === 'text' ? raw.replace(/\s+/g, ' ').trim() : htmlToText(raw).trim()
  return text.length > DELETE_PREVIEW_MAX ? `${text.slice(0, DELETE_PREVIEW_MAX - 1)}…` : text
}

// Own, not deleted, not a system event: the messages you can edit / delete.
export function isOwnEditableMessage(
  m: ChatMessage | undefined,
  myUserId: string | undefined,
): m is ChatMessage {
  if (!m || !myUserId) return false
  if (m.from?.user?.id !== myUserId) return false
  if (m.messageType === 'systemEventMessage') return false
  if (m.deletedDateTime) return false
  return true
}

export function openReactionPicker(
  store: Store<AppState>,
  chatId: string,
  messageId: string,
): void {
  store.set({ modal: { kind: 'reaction-picker', chatId, messageId }, inputZone: 'menu' })
}

export function openEditReactions(store: Store<AppState>, chatId: string, messageId: string): void {
  store.set({ modal: { kind: 'edit-reactions', chatId, messageId }, inputZone: 'menu' })
}

export function startEditMessage(store: Store<AppState>, messageId: string): void {
  store.set({ editingMessageId: messageId, inputZone: 'composer' })
}

export function confirmDeleteMessage(
  store: Store<AppState>,
  chatId: string,
  msg: ChatMessage,
): void {
  store.set({
    modal: { kind: 'confirm-delete', chatId, messageId: msg.id, preview: messagePreview(msg) },
    inputZone: 'menu',
  })
}

export function confirmDeleteChat(store: Store<AppState>, chatId: string, label: string): void {
  store.set({ modal: { kind: 'confirm-delete-chat', chatId, label }, inputZone: 'list' })
}

export function toggleChatRead(store: Store<AppState>, chat: Chat): void {
  store.set((s) => ({ unreadByChatId: toggleChatUnread(s.unreadByChatId, chat) }))
}

export function openChat(store: Store<AppState>, chatId: string): void {
  store.set({ focus: { kind: 'chat', chatId }, inputZone: 'list' })
}
