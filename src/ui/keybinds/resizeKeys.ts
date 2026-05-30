// Resize-mode keybind handler.
//
// Active when AppState.inputZone === 'resize'. Entered from the list zone
// via Ctrl-X. Owns:
//   h / Left  - shrink chat list by 1 column
//   l / Right - widen chat list by 1 column
//   k / Up    - shrink composer by 1 row
//   j / Down  - grow composer by 1 row
//   0         - reset both dimensions to auto (null)
//   Esc / Enter - leave resize mode, return to list zone
//
// Each step clamps against the same bounds as computeLayout.

import type { AppState, Settings, Store } from '../../state/store'
import { updateSettings } from '../../config/index'
import {
  CHAT_LIST_WIDTH_MIN,
  CHAT_LIST_WIDTH_MAX,
  COMPOSER_HEIGHT_MIN,
  COMPOSER_HEIGHT_MAX,
} from '../layout'
import type { KeyResult, RawKey } from './types'

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.max(lo, Math.min(hi, v))
}

export type ResizeKeysCtx = {
  store: Store<AppState>
  /** Current resolved chat list width (used to compute delta from). */
  currentChatListWidth: number
  /** Current resolved composer height. */
  currentComposerHeight: number
}

function persistAndUpdate(
  store: Store<AppState>,
  patch: Partial<Pick<Settings, 'chatListWidth' | 'composerHeight'>>,
): void {
  store.set((s) => ({ settings: { ...s.settings, ...patch } }))
  // Fire-and-forget: persist to disk. Errors are non-fatal.
  void updateSettings(patch).catch(() => undefined)
}

export function handleResizeKeys({ input, key }: RawKey, ctx: ResizeKeysCtx): KeyResult {
  const { store, currentChatListWidth, currentComposerHeight } = ctx
  const ch = input.toLowerCase()

  // Leave resize mode.
  if (key.escape || key.return) {
    store.set({ inputZone: 'list' })
    return 'handled'
  }

  // Reset both to auto.
  if (input === '0') {
    persistAndUpdate(store, { chatListWidth: null, composerHeight: null })
    return 'handled'
  }

  // Shrink chat list.
  if (ch === 'h' || key.leftArrow) {
    const next = clamp(currentChatListWidth - 1, CHAT_LIST_WIDTH_MIN, CHAT_LIST_WIDTH_MAX)
    persistAndUpdate(store, { chatListWidth: next })
    return 'handled'
  }

  // Widen chat list.
  if (ch === 'l' || key.rightArrow) {
    const next = clamp(currentChatListWidth + 1, CHAT_LIST_WIDTH_MIN, CHAT_LIST_WIDTH_MAX)
    persistAndUpdate(store, { chatListWidth: next })
    return 'handled'
  }

  // Shrink composer.
  if (ch === 'k' || key.upArrow) {
    const next = clamp(currentComposerHeight - 1, COMPOSER_HEIGHT_MIN, COMPOSER_HEIGHT_MAX)
    persistAndUpdate(store, { composerHeight: next })
    return 'handled'
  }

  // Grow composer.
  if (ch === 'j' || key.downArrow) {
    const next = clamp(currentComposerHeight + 1, COMPOSER_HEIGHT_MIN, COMPOSER_HEIGHT_MAX)
    persistAndUpdate(store, { composerHeight: next })
    return 'handled'
  }

  return 'pass'
}
