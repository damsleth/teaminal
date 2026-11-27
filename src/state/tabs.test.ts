import { describe, expect, test } from 'bun:test'
import { accountRef } from '../account'
import { accountStore, accountStoreFor, closeAccount, openAccount } from './accountStore'
import { applySeededState } from './seedFixtures'
import {
  createAppStore,
  resetAccountScopedState,
  type Focus,
  type Store,
  type AppState,
  type Tab,
} from './store'
import {
  activeTabIndex,
  followTabs,
  neighbourTab,
  openTarget,
  retargetChatTab,
  stepTab,
  tabViews,
  withoutChatTab,
} from './tabs'

const ALPHA = accountRef('alpha')
const BETA = accountRef('beta')
const chat = (chatId: string): Tab['focus'] => ({ kind: 'chat', chatId })
const channel: Tab['focus'] = { kind: 'channel', teamId: 't1', channelId: 'c1' }
const thread: Tab['focus'] = { kind: 'thread', teamId: 't1', channelId: 'c1', rootId: 'r1' }

function tabsStore(mode: 'single' | 'tabs' = 'tabs'): Store<AppState> {
  const store = createAppStore(ALPHA)
  store.set((s) => ({ settings: { ...s.settings, conversationMode: mode } }))
  followTabs(store)
  return store
}

const open = (store: Store<AppState>, focus: Focus) => store.set({ focus })
const tabFoci = (store: Store<AppState>) => store.get().tabs.map((t) => t.focus)
const setMode = (store: Store<AppState>, mode: 'single' | 'tabs') =>
  store.set((s) => ({ settings: { ...s.settings, conversationMode: mode } }))

describe('followTabs', () => {
  test('single mode: opening conversations makes no tabs', () => {
    const store = tabsStore('single')
    open(store, chat('a'))
    open(store, chat('b'))
    expect(store.get().tabs).toEqual([])
  })

  test('tabs mode: each opened conversation gets a tab, in order; re-opening switches', () => {
    const store = tabsStore()
    open(store, chat('a'))
    open(store, chat('b'))
    open(store, channel)
    expect(tabFoci(store)).toEqual([chat('a'), chat('b'), channel])
    expect(store.get().tabs.every((t) => t.account === ALPHA.id)).toBe(true)
    expect(activeTabIndex(store.get())).toBe(2)
    open(store, chat('a'))
    expect(store.get().tabs).toHaveLength(3)
    expect(activeTabIndex(store.get())).toBe(0)
  })

  test('the list focus leaves the tabs and has no active tab', () => {
    const store = tabsStore()
    open(store, chat('a'))
    open(store, { kind: 'list' })
    expect(tabFoci(store)).toEqual([chat('a')])
    expect(activeTabIndex(store.get())).toBe(-1)
  })

  test("a thread opens in its channel's tab, and back to the channel in the same tab", () => {
    const store = tabsStore()
    open(store, chat('a'))
    open(store, channel)
    open(store, thread)
    expect(tabFoci(store)).toEqual([chat('a'), thread])
    expect(activeTabIndex(store.get())).toBe(1)
    open(store, channel)
    expect(tabFoci(store)).toEqual([chat('a'), channel])
  })

  test('opening a channel whose tab shows a thread lands on the thread', () => {
    const store = tabsStore()
    open(store, channel)
    open(store, thread)
    open(store, chat('a'))
    expect(openTarget(store.get(), channel)).toEqual(thread)
    // Single mode opens what was asked for.
    setMode(store, 'single')
    expect(openTarget(store.get(), channel)).toEqual(channel)
  })

  test('flipping to single keeps the tabs; back to tabs adds the open conversation', () => {
    const store = tabsStore()
    open(store, chat('a'))
    open(store, chat('b'))
    setMode(store, 'single')
    open(store, chat('c'))
    expect(tabFoci(store)).toEqual([chat('a'), chat('b')])
    setMode(store, 'tabs')
    expect(tabFoci(store)).toEqual([chat('a'), chat('b'), chat('c')])
    expect(activeTabIndex(store.get())).toBe(2)
  })

  test('the same chat id in two accounts is two tabs', () => {
    const store = tabsStore()
    openAccount(store, BETA, { foreground: false })
    open(store, chat('a'))
    store.set({ tabs: [...store.get().tabs, { account: BETA.id, focus: chat('a') }] })
    expect(activeTabIndex(store.get())).toBe(0)
    open(store, chat('a'))
    expect(store.get().tabs).toHaveLength(2)
  })
})

describe('stepping and closing', () => {
  const three = () => {
    const store = tabsStore()
    for (const id of ['a', 'b', 'c']) open(store, chat(id))
    return store
  }

  test('next and previous wrap', () => {
    const store = three()
    expect(stepTab(store.get(), 1)).toBe(0)
    expect(stepTab(store.get(), -1)).toBe(1)
    open(store, chat('a'))
    expect(stepTab(store.get(), -1)).toBe(2)
    expect(stepTab(store.get(), 1)).toBe(1)
  })

  test('with the list focused, next is the first tab and previous the last', () => {
    const store = three()
    open(store, { kind: 'list' })
    expect(stepTab(store.get(), 1)).toBe(0)
    expect(stepTab(store.get(), -1)).toBe(2)
    expect(stepTab(tabsStore().get(), 1)).toBe(-1)
  })

  test('the neighbour of a closing tab is the previous one, else the next', () => {
    const tabs = three().get().tabs
    expect(neighbourTab(tabs, 2)).toBe(1)
    expect(neighbourTab(tabs, 1)).toBe(0)
    expect(neighbourTab(tabs, 0)).toBe(1)
    expect(neighbourTab(tabs.slice(0, 1), 0)).toBe(-1)
  })

  test("a deleted chat's tab goes; other accounts' tabs of the same id stay", () => {
    const tabs = [
      { account: ALPHA.id, focus: chat('a') },
      { account: BETA.id, focus: chat('a') },
    ] as AppState['tabs']
    expect(withoutChatTab(tabs, BETA.id, 'a')).toEqual([tabs[0]!])
    expect(withoutChatTab(tabs, ALPHA.id, 'x')).toBe(tabs)
  })

  test('a detached chat replaced by its canonical thread keeps its tab', () => {
    const tabs = [
      { account: ALPHA.id, focus: chat('a') },
      { account: ALPHA.id, focus: chat('detached') },
    ] as AppState['tabs']
    expect(retargetChatTab(tabs, ALPHA.id, 'detached', 'canon').map((t) => t.focus)).toEqual([
      chat('a'),
      chat('canon'),
    ])
    // Already open: the detached one's tab goes.
    expect(retargetChatTab(tabs, ALPHA.id, 'detached', 'a').map((t) => t.focus)).toEqual([
      chat('a'),
    ])
  })
})

describe('accounts', () => {
  test('closing an account removes its tabs, and only its tabs', () => {
    const store = tabsStore()
    openAccount(store, BETA, { foreground: false })
    open(store, chat('a'))
    store.set({ tabs: [...store.get().tabs, { account: BETA.id, focus: chat('b') }] })
    closeAccount(store, BETA.id)
    expect(store.get().tabs).toEqual([{ account: ALPHA.id, focus: chat('a') }])
    // Turning it on again opens it empty: no tabs come back.
    openAccount(store, BETA, { foreground: false })
    expect(store.get().tabs).toHaveLength(1)
  })

  test('closing the last account, or a single-mode account switch, clears the tabs', () => {
    const store = tabsStore()
    open(store, chat('a'))
    resetAccountScopedState(store, BETA)
    expect(store.get().tabs).toEqual([])
    open(store, chat('b'))
    closeAccount(store, BETA.id)
    expect(store.get().tabs).toEqual([])
  })
})

describe('tabViews', () => {
  function seeded() {
    const store = tabsStore()
    applySeededState(accountStore(store), 'alpha')
    return store
  }

  test("a chat's name, a channel's #name, a thread inside its channel", () => {
    const store = seeded()
    open(store, chat('seed-chat-ada'))
    open(store, chat('seed-chat-design-sync'))
    store.set({ channelsByTeam: { t1: [{ id: 'c1', displayName: 'launch' }] } })
    open(store, thread)
    expect(tabViews(store.get()).map((v) => v.label)).toEqual([
      'Ada Byron',
      'Design Sync',
      '#launch › thread',
    ])
  })

  test('the unread marker comes from the chat’s unread state', () => {
    const store = seeded()
    open(store, chat('seed-chat-ada'))
    open(store, chat('seed-chat-design-sync'))
    open(store, chat('seed-chat-ops'))
    store.set((s) => ({
      unreadByChatId: {
        ...s.unreadByChatId,
        'seed-chat-ada': { unreadCount: 2, mentionCount: 0 },
        'seed-chat-design-sync': { unreadCount: 1, mentionCount: 1 },
      },
    }))
    expect(tabViews(store.get()).map((v) => v.unread)).toEqual(['unread', 'mention', null])
  })

  test('with several accounts open each tab names its account', () => {
    const store = seeded()
    store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha', 'beta'] } }))
    expect(tabViews(store.get())).toEqual([])
    openAccount(store, BETA, { foreground: false })
    applySeededState(accountStoreFor(store, BETA), 'beta')
    open(store, chat('seed-chat-ada'))
    store.set({ tabs: [...store.get().tabs, { account: BETA.id, focus: chat('seed-chat-ada') }] })
    expect(tabViews(store.get()).map((v) => v.label)).toEqual([
      'Ada Byron · alpha',
      'ADA BYRON · beta',
    ])
  })
})
