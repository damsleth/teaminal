// Actions on one chat-list row or one message, shared by their keys
// (listKeys / chatKeys) and the context menu, so both always do the same.

import { accountRef } from '../../account'
import { accountStoreFor } from '../../state/accountStore'
import { toggleChatUnread, type AppState, type Focus, type Store } from '../../state/store'
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

// `alias` (unified sidebar): the row's account, when the chat may belong to
// an account other than the foreground. Absent = the foreground.
export function confirmDeleteChat(
  store: Store<AppState>,
  chatId: string,
  label: string,
  alias?: string,
): void {
  store.set({
    modal: {
      kind: 'confirm-delete-chat',
      chatId,
      label,
      ...(alias === undefined ? {} : { alias }),
    },
    inputZone: 'list',
  })
}

// Flips the row's own account's unread mark, without changing the foreground.
export function toggleChatRead(store: Store<AppState>, chat: Chat, alias?: string): void {
  if (alias !== undefined) {
    accountStoreFor(store, accountRef(alias)).set((s) => ({
      unreadByChatId: toggleChatUnread(s.unreadByChatId, chat),
    }))
    return
  }
  store.set((s) => ({ unreadByChatId: toggleChatUnread(s.unreadByChatId, chat) }))
}

// Swaps an open account to the foreground, keeping the list cursor and filter
// (SessionApi.setForeground with restoreUi: false).
export type ToForeground = (alias: string) => void

// Opening a row: its account comes to the foreground first when it is not
// there, then focus moves, so focus only ever names a foreground resource.
export function openFocus(
  store: Store<AppState>,
  focus: Exclude<Focus, { kind: 'list' }>,
  alias?: string,
  toForeground?: ToForeground,
): void {
  if (bringToFront(store, alias, toForeground)) store.set({ focus, inputZone: 'list' })
}

// False when the swap put up the auth-expired modal (the account's sign-in
// expired): the action stops there instead of running behind the modal.
export function bringToFront(
  store: Store<AppState>,
  alias: string | undefined,
  toForeground: ToForeground | undefined,
): boolean {
  if (alias === undefined || !toForeground) return true
  if (store.get().account?.id === accountRef(alias).id) return true
  toForeground(alias)
  return store.get().modal?.kind !== 'auth-expired'
}

export function openChat(
  store: Store<AppState>,
  chatId: string,
  alias?: string,
  toForeground?: ToForeground,
): void {
  openFocus(store, { kind: 'chat', chatId }, alias, toForeground)
}
