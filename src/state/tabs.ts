// Conversation tabs (settings.conversationMode 'tabs').
//
// AppState.tabs is global UI state: the open tabs in bar order, across
// accounts, each an account and a conversation. The active tab is the one
// whose account is in the foreground and whose conversation is open (focus),
// so switching tabs is a focus change: only the open conversation is polled,
// read-marked and quiet for notifications, as in single mode, and drafts and
// message cursors already live per conversation in each account's slice.
//
// followTabs keeps the list in step with focus: in tabs mode whatever
// conversation opens (a row, the palette, a new chat, an activity item) gets
// a tab, and a channel's tab follows into a thread and back. In single mode
// the list is left alone, kept for when tabs come back.

import { chatLabel, labelSuffix, unifiedSidebar } from './selectables'
import { accountSlice, type AppState, type Focus, type Store, type Tab } from './store'
import type { AccountId } from '../account'

export function tabsOn(s: Pick<AppState, 'settings'>): boolean {
  return s.settings.conversationMode === 'tabs'
}

// The focus belongs to the tab's conversation: the same chat, or the same
// channel (a thread shows inside its channel's tab).
export function sameTab(a: Focus, b: Focus): boolean {
  if (a.kind === 'list' || b.kind === 'list') return false
  if (a.kind === 'chat' || b.kind === 'chat') {
    return a.kind === 'chat' && b.kind === 'chat' && a.chatId === b.chatId
  }
  return a.teamId === b.teamId && a.channelId === b.channelId
}

// The tab of `focus` in `account`, -1 when it has none.
export function tabIndex(
  tabs: readonly Tab[],
  account: AccountId | undefined,
  focus: Focus,
): number {
  if (!account) return -1
  return tabs.findIndex((t) => t.account === account && sameTab(t.focus, focus))
}

// The active tab: the foreground account's open conversation. -1 with the
// list focused or no tab for it (single mode).
export function activeTabIndex(s: Pick<AppState, 'tabs' | 'account' | 'focus'>): number {
  return tabIndex(s.tabs, s.account?.id, s.focus)
}

// The store patch that gives the open conversation its tab in tabs mode: a
// new one at the end, or its own pointed at the channel's thread (or back).
// null when nothing changes.
export function followFocus(s: AppState): Pick<AppState, 'tabs'> | null {
  if (!tabsOn(s) || !s.account || s.focus.kind === 'list') return null
  const focus = s.focus
  const i = tabIndex(s.tabs, s.account.id, focus)
  if (i < 0) return { tabs: [...s.tabs, { account: s.account.id, focus }] }
  const tab = s.tabs[i]!
  if (tab.focus === focus || sameFocus(tab.focus, focus)) return null
  return { tabs: s.tabs.map((t, j) => (j === i ? { ...t, focus } : t)) }
}

function sameFocus(a: Tab['focus'], b: Tab['focus']): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'thread' || (b.kind === 'thread' && a.rootId === b.rootId)
}

// Keep the tab list in step with focus (followFocus) for as long as the
// returned unsubscribe is not called.
export function followTabs(store: Store<AppState>): () => void {
  return store.subscribe((s) => {
    const patch = followFocus(s)
    if (patch) store.set(patch)
  })
}

// Where opening `focus` in the foreground lands: its open tab as it is (a
// channel tab may be showing a thread), else `focus` itself.
export function openTarget(s: AppState, focus: Tab['focus']): Tab['focus'] {
  if (!tabsOn(s)) return focus
  const i = tabIndex(s.tabs, s.account?.id, focus)
  return i < 0 ? focus : s.tabs[i]!.focus
}

// The tab `dir` steps to from the active one, wrapping. With no active tab
// next is the first, previous the last. -1 without tabs.
export function stepTab(s: Pick<AppState, 'tabs' | 'account' | 'focus'>, dir: 1 | -1): number {
  const n = s.tabs.length
  if (n === 0) return -1
  const at = activeTabIndex(s)
  if (at < 0) return dir > 0 ? 0 : n - 1
  return (at + dir + n) % n
}

// The tab that becomes active when tab `i` closes: the previous one, else
// the next. An index into the list before the close; -1 when none is left.
export function neighbourTab(tabs: readonly Tab[], i: number): number {
  if (tabs.length <= 1) return -1
  return i > 0 ? i - 1 : i + 1
}

// `tabs` without the chat's tab in `account` (a deleted chat); the same
// array when it has none.
export function withoutChatTab(tabs: Tab[], account: AccountId | undefined, chatId: string): Tab[] {
  const i = tabIndex(tabs, account, { kind: 'chat', chatId })
  return i < 0 ? tabs : tabs.filter((_, j) => j !== i)
}

// The chat's tab in `account`, if any, now names `toChatId` (a detached chat
// replaced by its canonical thread). A tab already open there is kept
// instead.
export function retargetChatTab(
  tabs: Tab[],
  account: AccountId | undefined,
  fromChatId: string,
  toChatId: string,
): Tab[] {
  const from = tabIndex(tabs, account, { kind: 'chat', chatId: fromChatId })
  if (from < 0) return tabs
  if (tabIndex(tabs, account, { kind: 'chat', chatId: toChatId }) >= 0) {
    return tabs.filter((_, j) => j !== from)
  }
  return tabs.map((t, j) => (j === from ? { ...t, focus: { kind: 'chat', chatId: toChatId } } : t))
}

// What the tab bar shows for a tab: its conversation's name (with its
// account when several are open, as rows of the unified sidebar), and the
// chat's unread state.
export type TabView = { label: string; unread: 'mention' | 'unread' | null }

export function tabViews(s: AppState): TabView[] {
  const labelled = unifiedSidebar(s)
  return s.tabs.map((tab) => {
    const slice = accountSlice(s, tab.account)
    const ref = s.account?.id === tab.account ? s.account : s.backgroundAccounts[tab.account]?.ref
    const suffix = labelled ? labelSuffix(ref?.label) : ''
    const f = tab.focus
    if (f.kind === 'chat') {
      const chat = slice?.chats.find((c) => c.id === f.chatId)
      const name = chat
        ? chatLabel(chat, slice?.me?.id, { nameByUserId: slice?.nameByUserId })
        : 'chat'
      const activity = slice?.unreadByChatId[f.chatId]
      const unread = !activity
        ? null
        : activity.mentionCount > 0
          ? 'mention'
          : activity.unreadCount > 0
            ? 'unread'
            : null
      return { label: name + suffix, unread }
    }
    const channel = slice?.channelsByTeam[f.teamId]?.find((c) => c.id === f.channelId)
    const name = `#${channel?.displayName ?? '?'}${f.kind === 'thread' ? ' › thread' : ''}`
    return { label: name + suffix, unread: null }
  })
}
