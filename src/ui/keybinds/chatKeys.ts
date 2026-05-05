// Chat / channel zone keybind handler.
//
// Active when the user has a chat or channel focused AND inputZone ===
// 'list' (i.e. the message pane has focus, not the composer or filter).
// Owns: H/J/K/L/U/D message-cursor motion, Enter at top to load older,
// Esc to return to chat list. Tab to composer is handled by the
// shared App-level dispatcher because it is identical across zones.

import type { AppState, Focus, Store } from '../../state/store'
import type { KeyResult, RawKey } from './types'

export type ChatKeysCtx = {
  store: Store<AppState>
  focus: Focus
  // Current cursor position in the active conversation's messages list.
  // -1 / 0 are equivalent for "at top".
  activeMessageCursor: number
  // Id of the message under the cursor, used to open a thread.
  focusedMessageId?: string
  moveMessageCursor: (delta: number) => void
  jumpMessageBottom: () => void
  tryLoadOlder: () => void
}

// Half-page step used by U / D / PageUp / PageDown.
const HALF_PAGE = Math.ceil(20 / 2)

export function handleChatKeys({ input, key }: RawKey, ctx: ChatKeysCtx): KeyResult {
  const { store, moveMessageCursor, jumpMessageBottom, tryLoadOlder } = ctx
  if (ctx.focus.kind === 'list') return 'pass'

  // Thread-specific routing: h / Left / Esc must return to the parent
  // channel, not the list. Has to come before the generic 'h → list'
  // rule below.
  if (
    ctx.focus.kind === 'thread' &&
    (input === 'h' || input === 'H' || key.leftArrow || key.escape)
  ) {
    store.set({
      focus: { kind: 'channel', teamId: ctx.focus.teamId, channelId: ctx.focus.channelId },
    })
    return 'handled'
  }

  if (input === 'h' || input === 'H' || key.leftArrow) {
    store.set({ focus: { kind: 'list' }, inputZone: 'list' })
    return 'handled'
  }
  if (input === 'j' || input === 'J' || key.downArrow) {
    moveMessageCursor(1)
    return 'handled'
  }
  if (input === 'k' || input === 'K' || key.upArrow) {
    moveMessageCursor(-1)
    return 'handled'
  }
  if (input === 'u' || input === 'U' || (key as typeof key & { pageUp?: boolean }).pageUp) {
    moveMessageCursor(-HALF_PAGE)
    return 'handled'
  }
  if (input === 'd' || input === 'D' || (key as typeof key & { pageDown?: boolean }).pageDown) {
    moveMessageCursor(HALF_PAGE)
    return 'handled'
  }
  if (input === 'l' || input === 'L' || key.rightArrow) {
    if (ctx.activeMessageCursor === 0) tryLoadOlder()
    else jumpMessageBottom()
    return 'handled'
  }
  if (key.return && ctx.activeMessageCursor === 0) {
    tryLoadOlder()
    return 'handled'
  }
  // 't' opens the thread overlay when a channel root is focused.
  if (input === 't' && ctx.focus.kind === 'channel' && ctx.focusedMessageId) {
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
  // From a thread, h / Esc returns to its parent channel — handled
  // earlier, before the generic 'h → list' rule.
  if (key.escape) {
    store.set({ focus: { kind: 'list' }, inputZone: 'list' })
    return 'handled'
  }
  // '/' opens in-pane message search.
  if (input === '/') {
    store.set({ inputZone: 'message-search', messageSearchQuery: '', messageSearchFocusedId: null })
    return 'handled'
  }
  return 'pass'
}
