// Chat / channel zone keybind handler.
//
// Active when the user has a chat or channel focused AND inputZone ===
// 'list' (i.e. the message pane has focus, not the composer or filter).
// Owns: h/j/k/l/u/d message-cursor motion, u/k-at-top to load older,
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
  const ch = input.toLowerCase()
  if (ctx.focus.kind === 'list') return 'pass'

  // Thread-specific routing: h / Left / Esc must return to the parent
  // channel, not the list. Has to come before the generic 'h → list'
  // rule below.
  if (
    ctx.focus.kind === 'thread' &&
    (ch === 'h' || key.leftArrow || key.escape)
  ) {
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
    moveMessageCursor(1)
    return 'handled'
  }
  if (ch === 'k' || key.upArrow) {
    if (ctx.activeMessageCursor <= 0) tryLoadOlder()
    else moveMessageCursor(-1)
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
