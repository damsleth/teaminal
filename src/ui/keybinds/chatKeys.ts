// Chat / channel zone keybind handler.
//
// Active when the user has a chat or channel focused AND inputZone ===
// 'list' (i.e. the message pane has focus, not the composer or filter).
// Owns: h/j/k/l/u/d message-cursor motion, u/k-at-top to load older,
// Esc to return to chat list. Tab to composer is handled by the
// shared App-level dispatcher because it is identical across zones.

import type { AppState, Focus, Store } from '../../state/store'
import type { ChatMessage } from '../../types'
import { ownReactionType } from '../../state/messageMutations'
import { htmlToText } from '../../text/html'
import { openMenu } from '../MenuModal'
import type { Focusable } from '../messageFocusables'
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
  moveMessageCursor: (delta: number) => void
  jumpMessageBottom: () => void
  tryLoadOlder: () => void
  // Set the focus index within the current message's focusables.
  setAttachmentIndex: (index: number) => void
  // Open a focused link's URL externally (injected so the handler stays pure
  // and testable without spawning a browser).
  openLink: (href: string) => void
}

const DELETE_PREVIEW_MAX = 60

function messagePreview(m: ChatMessage): string {
  const raw = m.body?.content ?? ''
  const text =
    m.body?.contentType === 'text' ? raw.replace(/\s+/g, ' ').trim() : htmlToText(raw).trim()
  return text.length > DELETE_PREVIEW_MAX ? `${text.slice(0, DELETE_PREVIEW_MAX - 1)}…` : text
}

function isOwnEditableMessage(
  m: ChatMessage | undefined,
  myUserId: string | undefined,
): m is ChatMessage {
  if (!m || !myUserId) return false
  if (m.from?.user?.id !== myUserId) return false
  if (m.messageType === 'systemEventMessage') return false
  if (m.deletedDateTime) return false
  return true
}

// Half-page step used by U / D / PageUp / PageDown.
const HALF_PAGE = Math.ceil(20 / 2)

export function handleChatKeys({ input, key }: RawKey, ctx: ChatKeysCtx): KeyResult {
  const { store, moveMessageCursor, jumpMessageBottom, tryLoadOlder } = ctx
  const ch = input.toLowerCase()
  if (ctx.focus.kind === 'list') return 'pass'

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
    // Within a message, step back through its attachments before leaving it.
    if (ctx.focusedAttachmentIndex > 0) {
      ctx.setAttachmentIndex(ctx.focusedAttachmentIndex - 1)
      return 'handled'
    }
    if (ctx.activeMessageCursor <= 0) tryLoadOlder()
    else moveMessageCursor(-1)
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
  if (ch === 'u' || (key as typeof key & { pageUp?: boolean }).pageUp) {
    if (ctx.activeMessageCursor <= HALF_PAGE) {
      moveMessageCursor(-HALF_PAGE)
      tryLoadOlder()
      return 'handled'
    }
    moveMessageCursor(-HALF_PAGE)
    return 'handled'
  }
  if (ch === 'd' || (key as typeof key & { pageDown?: boolean }).pageDown) {
    moveMessageCursor(HALF_PAGE)
    return 'handled'
  }
  if (ch === 'l' || key.rightArrow) {
    jumpMessageBottom()
    return 'handled'
  }
  // 't' opens the thread overlay when a channel root is focused.
  if (ch === 't' && ctx.focus.kind === 'channel' && ctx.focusedMessageId) {
    store.set({
      focus: {
        kind: 'thread',
        teamId: ctx.focus.teamId,
        channelId: ctx.focus.channelId,
        rootId: ctx.focusedMessageId,
      },
    })
    return 'handled'
  }
  // Write actions are chat-only for now (channel message write paths differ).
  if (ctx.focus.kind === 'chat' && ctx.focusedMessage) {
    const chatId = ctx.focus.chatId
    const msg = ctx.focusedMessage
    // 'r' opens the reaction picker for the focused message.
    if (ch === 'r') {
      store.set({
        modal: {
          kind: 'reaction-picker',
          chatId,
          messageId: msg.id,
          current: ctx.myUserId ? ownReactionType(msg, ctx.myUserId) : null,
        },
        inputZone: 'menu',
      })
      return 'handled'
    }
    // 'e' edits the focused message (own, non-deleted, non-system only).
    if (ch === 'e' && isOwnEditableMessage(msg, ctx.myUserId)) {
      store.set({ editingMessageId: msg.id, inputZone: 'composer' })
      return 'handled'
    }
    // 'x' deletes the focused message after a confirmation prompt.
    if (ch === 'x' && isOwnEditableMessage(msg, ctx.myUserId)) {
      store.set({
        modal: { kind: 'confirm-delete', chatId, messageId: msg.id, preview: messagePreview(msg) },
        inputZone: 'menu',
      })
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
