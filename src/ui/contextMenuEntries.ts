// The context menu's entries for its target: a chat-list row or a message.
// Each entry runs the same action as its key (itemActions), and shows that
// key, so the menu also teaches the shortcuts.

import { accountRef } from '../account'
import {
  accountSlice,
  focusKey,
  type AppState,
  type FocusChannel,
  type FocusChat,
} from '../state/store'
import {
  confirmDeleteChat,
  confirmDeleteMessage,
  isOwnEditableMessage,
  openChat,
  openEditReactions,
  openReactionPicker,
  startEditMessage,
  toggleChatRead,
  type ToForeground,
} from './keybinds/itemActions'

// A chat row's `alias` is its account in the unified sidebar (absent = the
// foreground): the entries act on that account's chat.
export type ContextMenuTarget =
  | { kind: 'chat'; chatId: string; label: string; alias?: string }
  | { kind: 'message'; focus: FocusChat | FocusChannel; messageId: string }

export type ContextMenuEntry = {
  id: string
  label: string
  key: string
  run: () => void
}

export function contextMenuEntries(
  target: ContextMenuTarget,
  state: AppState,
  deps: {
    store: Parameters<typeof openChat>[0]
    openThread?: (focus: FocusChannel, messageId: string) => void
    toForeground?: ToForeground
  },
): ContextMenuEntry[] {
  const { store } = deps
  if (target.kind === 'chat') {
    const { alias } = target
    const slice = alias === undefined ? state : accountSlice(state, accountRef(alias).id)
    const chat = slice?.chats.find((c) => c.id === target.chatId)
    if (!slice || !chat) return []
    const unread = slice.unreadByChatId[chat.id]
    const isUnread = Boolean(unread && (unread.unreadCount > 0 || unread.mentionCount > 0))
    return [
      {
        id: 'open',
        label: 'Open',
        key: 'Enter',
        run: () => openChat(store, chat.id, alias, deps.toForeground),
      },
      {
        id: 'toggle-read',
        label: isUnread ? 'Mark as read' : 'Mark as unread',
        key: 'm',
        run: () => toggleChatRead(store, chat, alias),
      },
      {
        id: 'delete',
        label: 'Delete chat…',
        key: 'Ctrl+D',
        run: () => confirmDeleteChat(store, chat.id, target.label, alias),
      },
    ]
  }

  const conv = focusKey(target.focus)
  const msg = conv ? state.messagesByConvo[conv]?.find((m) => m.id === target.messageId) : undefined
  if (!msg) return []
  const entries: ContextMenuEntry[] = []
  if (target.focus.kind === 'chat') {
    const chatId = target.focus.chatId
    entries.push(
      {
        id: 'react',
        label: 'React…',
        key: 'r',
        run: () => openReactionPicker(store, chatId, msg.id),
      },
      {
        id: 'edit-reactions',
        label: 'Edit reactions',
        key: 't',
        run: () => openEditReactions(store, chatId, msg.id),
      },
    )
    if (isOwnEditableMessage(msg, state.me?.id)) {
      entries.push(
        { id: 'edit', label: 'Edit', key: 'e', run: () => startEditMessage(store, msg.id) },
        {
          id: 'delete',
          label: 'Delete…',
          key: 'x',
          run: () => confirmDeleteMessage(store, chatId, msg),
        },
      )
    }
  } else if (deps.openThread) {
    const focus = target.focus
    const openThread = deps.openThread
    entries.push({
      id: 'thread',
      label: 'Open thread',
      key: 't',
      run: () => openThread(focus, msg.id),
    })
  }
  return entries
}
