import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Key } from 'ink'
import { accountRef } from '../../account'
import { openAccount, setForeground } from '../../state/accountStore'
import { createAppStore, type AppState, type Store, type Tab } from '../../state/store'
import { activeTabIndex, followTabs } from '../../state/tabs'
import { handleFilterKeys } from './filterKeys'
import { openFocus } from './itemActions'
import { handleTabKeys } from './tabKeys'

// Ctrl+T persists conversationMode to config.json: point it at a temp dir.
let configHome: string
const prevConfigHome = process.env.XDG_CONFIG_HOME
beforeAll(() => {
  configHome = mkdtempSync(join(tmpdir(), 'teaminal-tab-keys-'))
  process.env.XDG_CONFIG_HOME = configHome
})
afterAll(() => {
  if (prevConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevConfigHome
  rmSync(configHome, { recursive: true, force: true })
})

const ALPHA = accountRef('alpha')
const BETA = accountRef('beta')
const chat = (chatId: string): Tab['focus'] => ({ kind: 'chat', chatId })

function key(over: Partial<Key> = {}): Key {
  return { ctrl: false, meta: false, shift: false, ...over } as Key
}

function setup(mode: 'single' | 'tabs' = 'tabs', open: string[] = ['a', 'b', 'c']) {
  const store = createAppStore(ALPHA)
  store.set((s) => ({ settings: { ...s.settings, conversationMode: mode } }))
  followTabs(store)
  if (mode === 'single')
    store.set((s) => ({ settings: { ...s.settings, conversationMode: 'tabs' } }))
  for (const id of open) store.set({ focus: chat(id) })
  if (mode === 'single')
    store.set((s) => ({ settings: { ...s.settings, conversationMode: 'single' } }))
  const foregrounded: string[] = []
  const toForeground = (alias: string) => {
    foregrounded.push(alias)
    setForeground(store, accountRef(alias).id, { restoreUi: false })
  }
  const press = (input: string, over: Partial<Key> = {}) =>
    handleTabKeys({ input, key: key(over) }, { store, toForeground })
  return { store, press, foregrounded }
}

const focusOf = (store: Store<AppState>) => store.get().focus

describe('tab keys in tabs mode', () => {
  test('] and [ step through the tabs, wrapping', () => {
    const { store, press } = setup()
    expect(focusOf(store)).toEqual(chat('c'))
    expect(press(']')).toBe('handled')
    expect(focusOf(store)).toEqual(chat('a'))
    expect(press('[')).toBe('handled')
    expect(focusOf(store)).toEqual(chat('c'))
    press('[')
    expect(focusOf(store)).toEqual(chat('b'))
    expect(store.get().tabs).toHaveLength(3)
  })

  test('1-9 jump to that tab; a digit past the last tab does nothing', () => {
    const { store, press } = setup()
    expect(press('2')).toBe('handled')
    expect(focusOf(store)).toEqual(chat('b'))
    expect(press('7')).toBe('handled')
    expect(focusOf(store)).toEqual(chat('b'))
    expect(press('0')).toBe('pass')
  })

  test('they work from the list focus too, and open the conversation pane', () => {
    const { store, press } = setup()
    store.set({ focus: { kind: 'list' }, inputZone: 'list' })
    press(']')
    expect(focusOf(store)).toEqual(chat('a'))
    store.set({ focus: { kind: 'list' } })
    press('[')
    expect(focusOf(store)).toEqual(chat('c'))
    expect(store.get().inputZone).toBe('list')
  })

  test('Ctrl+W closes the active tab; the previous one takes over, else the next', () => {
    const { store, press } = setup()
    press('2')
    expect(press('w', { ctrl: true })).toBe('handled')
    expect(store.get().tabs.map((t) => t.focus)).toEqual([chat('a'), chat('c')])
    expect(focusOf(store)).toEqual(chat('a'))
    press('w', { ctrl: true })
    expect(store.get().tabs.map((t) => t.focus)).toEqual([chat('c')])
    expect(focusOf(store)).toEqual(chat('c'))
  })

  test('closing the last tab leaves the empty pane with the list focused', () => {
    const { store, press } = setup('tabs', ['a'])
    store.set({ inputZone: 'list' })
    press('w', { ctrl: true })
    expect(store.get().tabs).toEqual([])
    expect(focusOf(store)).toEqual({ kind: 'list' })
    expect(store.get().inputZone).toBe('list')
  })

  test('Ctrl+W with no active tab (list focused) closes nothing', () => {
    const { store, press } = setup()
    store.set({ focus: { kind: 'list' } })
    expect(press('w', { ctrl: true })).toBe('handled')
    expect(store.get().tabs).toHaveLength(3)
  })

  test('other keys, and other Ctrl keys, pass to the list and chat handlers', () => {
    const { press } = setup()
    for (const input of ['j', 'h', 'l', 't', '.', ' ']) expect(press(input)).toBe('pass')
    for (const input of ['[', ']', '1', 'b', 'd']) expect(press(input, { ctrl: true })).toBe('pass')
    expect(press('1', { meta: true })).toBe('pass')
  })

  test('a modal that keeps the list zone (confirm delete) gets the keys', () => {
    const { store, press } = setup()
    store.set({ modal: { kind: 'confirm-delete-chat', chatId: 'c', label: 'c' } })
    for (const input of ['[', ']', '1']) expect(press(input)).toBe('pass')
    expect(press('w', { ctrl: true })).toBe('pass')
    expect(press('t', { ctrl: true })).toBe('pass')
    expect(focusOf(store)).toEqual(chat('c'))
  })

  test('drafts and message cursors stay with their conversation across switches', () => {
    const { store, press } = setup()
    store.set({
      draftsByConvo: { 'chat:a': 'half a [reply] 1' },
      messageCursorByConvo: { 'chat:a': 4, 'chat:c': 9 },
    })
    press('1')
    press(']')
    press('3')
    press('1')
    expect(store.get().draftsByConvo).toEqual({ 'chat:a': 'half a [reply] 1' })
    expect(store.get().messageCursorByConvo).toEqual({ 'chat:a': 4, 'chat:c': 9 })
  })
})

describe('single mode', () => {
  test('the tab keys pass through and change nothing', () => {
    const { store, press } = setup('single')
    const before = store.get()
    for (const input of ['[', ']', '1', '2']) expect(press(input)).toBe('pass')
    expect(press('w', { ctrl: true })).toBe('pass')
    expect(store.get()).toBe(before)
  })

  test('Ctrl+T flips the mode both ways and keeps the tabs', async () => {
    const { store, press } = setup('single')
    expect(press('t', { ctrl: true })).toBe('handled')
    expect(store.get().settings.conversationMode).toBe('tabs')
    expect(store.get().tabs).toHaveLength(3)
    expect(activeTabIndex(store.get())).toBe(2)
    press('t', { ctrl: true })
    expect(store.get().settings.conversationMode).toBe('single')
    expect(store.get().tabs).toHaveLength(3)
    // Let the fire-and-forget config writes land in the temp dir.
    await Bun.sleep(20)
  })
})

describe('several accounts', () => {
  function twoAccounts() {
    const t = setup('tabs', ['a'])
    openAccount(t.store, BETA, { foreground: false })
    t.store.set({ tabs: [...t.store.get().tabs, { account: BETA.id, focus: chat('b') }] })
    return t
  }

  test("switching to another account's tab brings that account to the front", () => {
    const { store, press, foregrounded } = twoAccounts()
    press(']')
    expect(foregrounded).toEqual(['beta'])
    expect(store.get().account?.id).toBe(BETA.id)
    expect(focusOf(store)).toEqual(chat('b'))
    expect(activeTabIndex(store.get())).toBe(1)
    // And back: alpha's tab is alpha's chat, not beta's chat of that id.
    press('1')
    expect(foregrounded).toEqual(['beta', 'alpha'])
    expect(store.get().account?.id).toBe(ALPHA.id)
    expect(focusOf(store)).toEqual(chat('a'))
    expect(store.get().tabs).toHaveLength(2)
  })

  test("a draft typed in another account's chat survives switching away and back", () => {
    const { store, press } = twoAccounts()
    press('2')
    store.set({ draftsByConvo: { 'chat:b': 'from beta' } })
    press('1')
    expect(store.get().draftsByConvo['chat:b']).toBeUndefined()
    press('2')
    expect(store.get().draftsByConvo).toEqual({ 'chat:b': 'from beta' })
  })

  test("closing a tab whose neighbour is another account's brings that account forward", () => {
    const { store, press, foregrounded } = twoAccounts()
    press('2')
    store.set({ tabs: [...store.get().tabs, { account: ALPHA.id, focus: chat('z') }] })
    press('1')
    press('w', { ctrl: true })
    // Tab 1 had no previous: the next one (beta's) takes over.
    expect(foregrounded).toEqual(['beta', 'alpha', 'beta'])
    expect(store.get().account?.id).toBe(BETA.id)
    expect(store.get().tabs.map((t) => [t.account, t.focus])).toEqual([
      [BETA.id, chat('b')],
      [ALPHA.id, chat('z')],
    ])
  })

  test('without a way to bring the account forward, the tab is not switched to', () => {
    const { store } = twoAccounts()
    handleTabKeys({ input: ']', key: key() }, { store })
    expect(store.get().account?.id).toBe(ALPHA.id)
    expect(focusOf(store)).toEqual(chat('a'))
  })
})

test('in the filter, [ ] and digits are typed into the filter', () => {
  const { store } = setup()
  store.set({ inputZone: 'filter', filter: '' })
  for (const input of ['[', '2', ']']) {
    handleFilterKeys(
      { input, key: key() },
      {
        store,
        filter: store.get().filter,
        me: undefined,
        chats: [],
        teams: [],
        channelsByTeam: {},
        openNewChatPrompt: () => {},
      },
    )
  }
  expect(store.get().filter).toBe('[2]')
  expect(store.get().tabs).toHaveLength(3)
})

test('opening a channel whose tab shows a thread switches to the tab as it is', () => {
  const { store } = setup('tabs', ['a'])
  const thread: Tab['focus'] = { kind: 'thread', teamId: 't1', channelId: 'c1', rootId: 'r1' }
  store.set({ focus: { kind: 'channel', teamId: 't1', channelId: 'c1' } })
  store.set({ focus: thread })
  store.set({ focus: chat('a') })
  openFocus(store, { kind: 'channel', teamId: 't1', channelId: 'c1' })
  expect(store.get().focus).toEqual(thread)
  expect(store.get().tabs).toHaveLength(2)
})
