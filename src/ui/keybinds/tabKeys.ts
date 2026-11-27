// Conversation tab keys (src/state/tabs.ts), list and conversation focus
// only: App runs this ahead of the chat and list handlers, which never see
// the composer, the filter, prompts or modals either.
//
//   Ctrl+T     flip settings.conversationMode (single <-> tabs), any mode
//   [ / ]      previous / next tab, wrapping          (tabs mode)
//   1-9        that tab                               (tabs mode)
//   Ctrl+W     close the active tab                   (tabs mode)
//
// In single mode the tab keys pass through, so they do what they did before.

import { owaProfile } from '../../account'
import { warn } from '../../log'
import { activeTabIndex, neighbourTab, stepTab, tabIndex, tabsOn } from '../../state/tabs'
import type { AppState, Store } from '../../state/store'
import { updateSetting } from '../menu'
import { bringToFront, type ToForeground } from './itemActions'
import type { KeyResult, RawKey } from './types'

export type TabKeysCtx = {
  store: Store<AppState>
  // Brings another open account to the foreground (SessionApi.setForeground
  // with restoreUi: false), as opening a row of its section does.
  toForeground?: ToForeground
}

// Show tab `i`: its account comes to the foreground first when it is not
// there, then its conversation opens.
export function switchToTab(store: Store<AppState>, i: number, toForeground?: ToForeground): void {
  const s = store.get()
  const tab = s.tabs[i]
  if (!tab) return
  if (tab.account !== s.account?.id) {
    const ref = s.backgroundAccounts[tab.account]?.ref
    const alias = ref ? owaProfile(ref) : undefined
    if (alias === undefined || !toForeground) return
    if (!bringToFront(store, alias, toForeground)) return
  }
  store.set({ focus: tab.focus, inputZone: 'list' })
}

// The next (1) or previous (-1) tab, wrapping.
export function stepToTab(store: Store<AppState>, dir: 1 | -1, toForeground?: ToForeground): void {
  const i = stepTab(store.get(), dir)
  if (i >= 0) switchToTab(store, i, toForeground)
}

// Close the active tab: its neighbour (the previous one, else the next)
// becomes active; closing the last one leaves the list focused.
export function closeActiveTab(store: Store<AppState>, toForeground?: ToForeground): void {
  const s = store.get()
  const at = activeTabIndex(s)
  if (at < 0) return
  const closing = s.tabs[at]!
  const next = neighbourTab(s.tabs, at)
  if (next >= 0) switchToTab(store, next, toForeground)
  // Removed after the switch, and with the focus moved off it in the same
  // update when the switch could not happen: tabs mode gives an open
  // conversation its tab back.
  store.set((now) => {
    const tabs = now.tabs.filter((t) => t !== closing)
    const stillOpen = tabIndex([closing], now.account?.id, now.focus) === 0
    return stillOpen ? { tabs, focus: { kind: 'list' }, inputZone: 'list' } : { tabs }
  })
}

export function toggleConversationMode(store: Store<AppState>): void {
  const next = tabsOn(store.get()) ? 'single' : 'tabs'
  void updateSetting(store, 'conversationMode', next).catch((err) => {
    warn(
      'config: failed to persist conversationMode:',
      err instanceof Error ? err.message : String(err),
    )
  })
}

export function handleTabKeys({ input, key }: RawKey, ctx: TabKeysCtx): KeyResult {
  const { store, toForeground } = ctx
  const s = store.get()
  // A modal that leaves the list zone (confirm-delete-chat) owns its keys.
  if (s.modal !== null) return 'pass'
  if (key.ctrl && input === 't') {
    toggleConversationMode(store)
    return 'handled'
  }
  if (!tabsOn(s)) return 'pass'
  if (key.ctrl && input === 'w') {
    closeActiveTab(store, toForeground)
    return 'handled'
  }
  if (key.ctrl || key.meta) return 'pass'
  if (input === '[' || input === ']') {
    stepToTab(store, input === ']' ? 1 : -1, toForeground)
    return 'handled'
  }
  if (input.length === 1 && input >= '1' && input <= '9') {
    switchToTab(store, Number(input) - 1, toForeground)
    return 'handled'
  }
  return 'pass'
}
