// Chat / channel zone keybind handler.
//
// Active when the user has a chat or channel focused AND inputZone ===
// 'list' (i.e. the message pane has focus, not the composer or filter).
// Owns: h/j/k/u/d/gg/G message-cursor motion, u/k-at-top to load older,
// l / space into a focused thread, Esc to return to chat list. Tab to composer is handled by the
// shared App-level dispatcher because it is identical across zones.

import {
  emptyMessageCache,
  focusKey,
  type AppState,
  type Focus,
  type Store,
} from '../../state/store'
import { groupChannelThreads } from '../../state/channelThreads'
import type { ChatMessage } from '../../types'
import { openMenu } from '../MenuModal'
import { openContextMenu } from '../ContextMenu'
import type { Focusable } from '../messageFocusables'
import {
  confirmDeleteMessage,
  openEditReactions,
  openReactionPicker,
  startEditMessage,
} from './itemActions'
import { isOwnEditableMessage } from './itemActions'
import type { KeyResult, RawKey } from './types'

export type ChatKeysCtx = {
  store: Store<AppState>
  focus: Focus
  // Current cursor position in the active conversation's messages list.
  // -1 / 0 are equivalent for "at top".
  activeMessageCursor: number
  // Id of the message under the cursor, used to open a thread.
  focusedMessageId?: string
  // The message under the cursor, when one is focused. Used to gate edit /
  // delete to the user's own messages and to seed the reaction picker.
  focusedMessage?: ChatMessage
  // The signed-in user's id, for the self-message gate.
  myUserId?: string
  // Focusable units of the focused message ([message, ...images, ...links]).
  // Index 0 is the message body; j/k step through the rest.
  focusables: Focusable[]
  // Current focus index within `focusables` (0 = the message body).
  focusedAttachmentIndex: number
  // atEnd lands on the destination message's last focusable instead of its body.
  moveMessageCursor: (delta: number, atEnd?: boolean) => void
  jumpMessageBottom: () => void
  tryLoadOlder: () => void
  // Set the focus index within the current message's focusables.
  setAttachmentIndex: (index: number) => void
  // Open a focused link's URL externally (injected so the handler stays pure
  // and testable without spawning a browser).
  openLink: (href: string) => void
}

// Open the thread overlay for a channel root. Seed the thread from the
// already-loaded channel stream so it shows instantly; the active loop then
// refreshes/completes it via the chatsvc sub-conversation door. Both write
// the same threadConv, so render + cursor stay consistent.
export function openThread(
  store: Store<AppState>,
  focus: Extract<Focus, { kind: 'channel' }>,
  rootId: string,
  root: ChatMessage | undefined,
): void {
  const { teamId, channelId } = focus
  const nextFocus: Focus = { kind: 'thread', teamId, channelId, rootId }
  const threadConv = focusKey(nextFocus)
  const channelConv = focusKey(focus)
  store.set((s) => {
    // Don't clobber a thread already loaded from a previous open; let the
    // active loop refresh it instead.
    if (!threadConv || s.messageCacheByConvo[threadConv]) return { focus: nextFocus }
    const stream = channelConv ? (s.messagesByConvo[channelConv] ?? []) : []
    const { repliesByRoot } = groupChannelThreads(stream)
    const seeded = [...(root ? [root] : []), ...(repliesByRoot[rootId] ?? [])]
    if (seeded.length === 0) return { focus: nextFocus }
    return {
      focus: nextFocus,
      messagesByConvo: { ...s.messagesByConvo, [threadConv]: seeded },
      messageCacheByConvo: { ...s.messageCacheByConvo, [threadConv]: emptyMessageCache(seeded) },
    }
  })
}

// Half-page step used by U / D / PageUp / PageDown.
const HALF_PAGE = Math.ceil(20 / 2)

// First half of a vim-style `gg` (jump to top). Any other key clears it.
let pendingG = false

export function handleChatKeys({ input, key }: RawKey, ctx: ChatKeysCtx): KeyResult {
  const { store, moveMessageCursor, jumpMessageBottom, tryLoadOlder } = ctx
  const ch = input.toLowerCase()
  if (ctx.focus.kind === 'list') return 'pass'

  const wasPendingG = pendingG
  pendingG = false
  if (input === 'g') {
    if (wasPendingG) moveMessageCursor(-ctx.activeMessageCursor)
    else pendingG = true
    return 'handled'
  }

  // Thread-specific routing: h / Left return to the parent channel.
  // Has to come before the generic 'h → list' rule below. Esc is
  // handled later — it always opens the menu, regardless of focus.
  if (ctx.focus.kind === 'thread' && (ch === 'h' || key.leftArrow)) {
    store.set({
      focus: { kind: 'channel', teamId: ctx.focus.teamId, channelId: ctx.focus.channelId },
    })
    return 'handled'
  }

  if (ch === 'h' || key.leftArrow) {
    store.set({ focus: { kind: 'list' }, inputZone: 'list' })
    return 'handled'
  }
  if (ch === 'j' || key.downArrow) {
    // Step through the focused message's attachments first, then roll over
    // to the next message (which resets the attachment index to 0).
    if (ctx.focusedAttachmentIndex < ctx.focusables.length - 1) {
      ctx.setAttachmentIndex(ctx.focusedAttachmentIndex + 1)
    } else {
      moveMessageCursor(1)
    }
    return 'handled'
  }
  if (ch === 'k' || key.upArrow) {
    // Within a message, step back through its attachments before leaving it;
    // the previous message is entered at its last attachment so k mirrors j.
    if (ctx.focusedAttachmentIndex > 0) {
      ctx.setAttachmentIndex(ctx.focusedAttachmentIndex - 1)
      return 'handled'
    }
    if (ctx.activeMessageCursor <= 0) tryLoadOlder()
    else moveMessageCursor(-1, true)
    return 'handled'
  }
  // Space activates the focused attachment: an image opens the full-size
  // image modal, a link opens in the system browser. Space on the message
  // body (index 0) is left to fall through. Works in any conversation kind
  // since both actions are read-only.
  if (input === ' ' && ctx.focusedAttachmentIndex > 0) {
    const focusable = ctx.focusables[ctx.focusedAttachmentIndex]
    if (focusable?.kind === 'image') {
      store.set({ modal: { kind: 'image', ref: focusable.ref }, inputZone: 'menu' })
      return 'handled'
    }
    if (focusable?.kind === 'link') {
      ctx.openLink(focusable.ref.href)
      return 'handled'
    }
  }
  // Space or l / Right on the focused reply badge enters the thread.
  if (
    (input === ' ' || ch === 'l' || key.rightArrow) &&
    ctx.focusables[ctx.focusedAttachmentIndex]?.kind === 'thread' &&
    ctx.focus.kind === 'channel' &&
    ctx.focusedMessageId
  ) {
    openThread(store, ctx.focus, ctx.focusedMessageId, ctx.focusedMessage)
    return 'handled'
  }
  if (ch === 'u' || (key as typeof key & { pageUp?: boolean }).pageUp) {
    if (ctx.activeMessageCursor <= HALF_PAGE) {
      moveMessageCursor(-HALF_PAGE)
      tryLoadOlder()
      return 'handled'
    }
    moveMessageCursor(-HALF_PAGE)
    return 'handled'
  }
  // ctrl+d is delete-chat (handled by the list dispatcher), not half-page.
  if ((ch === 'd' && !key.ctrl) || (key as typeof key & { pageDown?: boolean }).pageDown) {
    moveMessageCursor(HALF_PAGE)
    return 'handled'
  }
  if (input === 'G') {
    jumpMessageBottom()
    return 'handled'
  }
  // l / Right only enter a focused reply badge (above); swallow them otherwise
  // so they don't fall through to the list dispatcher.
  if (ch === 'l' || key.rightArrow) return 'handled'
  // 't' opens the thread overlay when a channel root is focused.
  // '.' (Ctrl+. where the terminal reports it) opens the context menu for
  // the focused message.
  if (
    input === '.' &&
    ctx.focusedMessageId &&
    (ctx.focus.kind === 'chat' || ctx.focus.kind === 'channel')
  ) {
    openContextMenu(store, { kind: 'message', focus: ctx.focus, messageId: ctx.focusedMessageId })
    return 'handled'
  }
  if (ch === 't' && ctx.focus.kind === 'channel' && ctx.focusedMessageId) {
    openThread(store, ctx.focus, ctx.focusedMessageId, ctx.focusedMessage)
    return 'handled'
  }
  // Write actions are chat-only for now (channel message write paths differ).
  if (ctx.focus.kind === 'chat' && ctx.focusedMessage) {
    const chatId = ctx.focus.chatId
    const msg = ctx.focusedMessage
    // 'r' opens the reaction picker for the focused message (delegates to the
    // macOS system emoji picker — see ReactionPickerModal).
    if (ch === 'r') {
      openReactionPicker(store, chatId, msg.id)
      return 'handled'
    }
    // 't' opens the edit-reactions modal to view / remove the user's
    // existing reactions on the focused message.
    if (ch === 't') {
      openEditReactions(store, chatId, msg.id)
      return 'handled'
    }
    // 'e' edits the focused message (own, non-deleted, non-system only).
    if (ch === 'e' && isOwnEditableMessage(msg, ctx.myUserId)) {
      startEditMessage(store, msg.id)
      return 'handled'
    }
    // 'x' deletes the focused message after a confirmation prompt.
    if (ch === 'x' && isOwnEditableMessage(msg, ctx.myUserId)) {
      confirmDeleteMessage(store, chatId, msg)
      return 'handled'
    }
  }
  // Esc always opens the menu overlay, regardless of focus. The menu
  // itself toggles closed on Esc, so the binding behaves as a toggle.
  // Use h / Left / l-Tab to move between panes instead.
  if (key.escape) {
    openMenu(store)
    return 'handled'
  }
  // '/' opens in-pane message search.
  if (input === '/') {
    store.set({ inputZone: 'message-search', messageSearchQuery: '', messageSearchFocusedId: null })
    return 'handled'
  }
  return 'pass'
}
