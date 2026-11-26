import { describe, expect, mock, test } from 'bun:test'
import type { Key } from 'ink'
import { handleListKeys, type ListKeysCtx } from './listKeys'
import { accountRef } from '../../account'
import { openAccount, setForeground } from '../../state/accountStore'
import {
  CHAT_SECTION_CAP,
  cursorAt,
  favoritesFor,
  resolveCursor,
  unifiedListInput,
  visibleList,
} from '../../state/selectables'
import { createAppStore, type AccountSlice, type Settings } from '../../state/store'
import type { Chat } from '../../types'

// Collapsing a section persists to config.json; keep the fire-and-forget
// write off the real config in tests. The store update is what matters here.
mock.module('../../config/index', () => ({
  updateSettings: () => Promise.resolve({}),
}))

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  } as Key
}

function chat(id: string, members: string[] = []): Chat {
  return {
    id,
    chatType: 'oneOnOne',
    createdDateTime: '2026-01-01T00:00:00Z',
    topic: id,
    members: members.map((u) => ({ id: u, userId: u, displayName: u })),
  }
}

function makeCtx(opts?: Partial<ListKeysCtx>): {
  ctx: ListKeysCtx
  store: ReturnType<typeof createAppStore>
  exits: number
  refreshes: number
  hardRefreshes: number
  newChats: string[]
} {
  const store = createAppStore()
  let exits = 0
  let refreshes = 0
  let hardRefreshes = 0
  const newChats: string[] = []
  const ctx: ListKeysCtx = {
    store,
    me: { id: 'me', displayName: 'Me', userPrincipalName: 'me@x', mail: null },
    chats: [chat('a'), chat('b'), chat('c')],
    teams: [],
    channelsByTeam: {},
    settings: { chatListSort: 'recent', chatListGroupByType: false },
    filter: '',
    expandedChatSections: {},
    cursor: 0,
    focus: { kind: 'list' },
    exit: () => {
      exits++
    },
    refresh: () => {
      refreshes++
    },
    hardRefresh: () => {
      hardRefreshes++
    },
    openNewChatPrompt: (q) => {
      newChats.push(q ?? '')
    },
    ...opts,
  }
  return {
    ctx,
    store,
    get exits() {
      return exits
    },
    get refreshes() {
      return refreshes
    },
    get hardRefreshes() {
      return hardRefreshes
    },
    newChats,
  }
}

describe('handleListKeys', () => {
  test('Ctrl+C exits', () => {
    const a = makeCtx()
    expect(handleListKeys({ input: 'c', key: makeKey({ ctrl: true }) }, a.ctx)).toBe('handled')
    expect(a.exits).toBe(1)
  })

  test('q exits when in list focus', () => {
    const a = makeCtx()
    handleListKeys({ input: 'q', key: makeKey() }, a.ctx)
    expect(a.exits).toBe(1)
  })

  test('r calls refresh', () => {
    const a = makeCtx()
    handleListKeys({ input: 'r', key: makeKey() }, a.ctx)
    expect(a.refreshes).toBe(1)
  })

  test('s opens server-side message search', () => {
    const a = makeCtx()
    expect(handleListKeys({ input: 's', key: makeKey() }, a.ctx)).toBe('handled')
    expect(a.store.get().modal?.kind).toBe('message-search-global')
    expect(a.store.get().inputZone).toBe('menu')
  })

  test('p opens the people directory (new-chat prompt with empty query)', () => {
    const a = makeCtx()
    expect(handleListKeys({ input: 'p', key: makeKey() }, a.ctx)).toBe('handled')
    expect(a.newChats).toEqual([''])
  })

  test('Shift+R calls hard refresh', () => {
    const a = makeCtx()
    handleListKeys({ input: 'R', key: makeKey() }, a.ctx)
    expect(a.hardRefreshes).toBe(1)
    expect(a.refreshes).toBe(0)
  })

  test('/ enters filter mode', () => {
    const a = makeCtx()
    handleListKeys({ input: '/', key: makeKey() }, a.ctx)
    expect(a.store.get().inputZone).toBe('filter')
  })

  test('? opens the keybinds modal', () => {
    const a = makeCtx()
    handleListKeys({ input: '?', key: makeKey() }, a.ctx)
    expect(a.store.get().modal?.kind).toBe('keybinds')
  })

  test('n opens the new-chat prompt with the current filter case-insensitively', () => {
    const a = makeCtx({ filter: 'Kari' })
    handleListKeys({ input: 'N', key: makeKey() }, a.ctx)
    handleListKeys({ input: 'n', key: makeKey() }, a.ctx)
    expect(a.newChats).toEqual(['Kari', 'Kari'])
  })

  test('j moves cursor down', () => {
    const a = makeCtx({ cursor: 0 })
    handleListKeys({ input: 'j', key: makeKey() }, a.ctx)
    expect(a.store.get().cursor).toBe(1)
  })

  test('down arrow moves cursor down', () => {
    const a = makeCtx({ cursor: 0 })
    handleListKeys({ input: '', key: makeKey({ downArrow: true }) }, a.ctx)
    expect(a.store.get().cursor).toBe(1)
  })

  test('k moves cursor up', () => {
    const a = makeCtx({ cursor: 1 })
    handleListKeys({ input: 'k', key: makeKey() }, a.ctx)
    expect(a.store.get().cursor).toBe(0)
  })

  test('u moves cursor up half a page in the sidebar', () => {
    const chats = Array.from({ length: 20 }, (_, i) => chat(`c${i}`))
    const a = makeCtx({ chats, cursor: 15 })
    handleListKeys({ input: 'u', key: makeKey() }, a.ctx)
    expect(a.store.get().cursor).toBe(5)
  })

  test('d moves cursor down half a page in the sidebar', () => {
    const chats = Array.from({ length: 20 }, (_, i) => chat(`c${i}`))
    const a = makeCtx({ chats, cursor: 5 })
    handleListKeys({ input: 'd', key: makeKey() }, a.ctx)
    expect(a.store.get().cursor).toBe(15)
  })

  test('Enter on a chat row sets focus to that chat', () => {
    const a = makeCtx({ cursor: 1 })
    handleListKeys({ input: '', key: makeKey({ return: true }) }, a.ctx)
    const focus = a.store.get().focus
    expect(focus.kind).toBe('chat')
    expect(focus.kind === 'chat' && focus.chatId).toBe('b')
  })

  test('h is handled (no-op) so it does not fall through', () => {
    const a = makeCtx()
    expect(handleListKeys({ input: 'h', key: makeKey() }, a.ctx)).toBe('handled')
    // No state change.
    expect(a.store.get().focus.kind).toBe('list')
  })

  test('Esc opens the menu modal when no chat is focused', () => {
    const a = makeCtx()
    handleListKeys({ input: '', key: makeKey({ escape: true }) }, a.ctx)
    expect(a.store.get().modal?.kind).toBe('menu')
  })

  test('Esc with empty list still opens the menu', () => {
    const a = makeCtx({ chats: [] })
    handleListKeys({ input: '', key: makeKey({ escape: true }) }, a.ctx)
    expect(a.store.get().modal?.kind).toBe('menu')
  })

  test('Filter that matches no items but looks like a name → synthetic new-chat row', () => {
    const a = makeCtx({ filter: 'Kari', chats: [], cursor: 0 })
    handleListKeys({ input: '', key: makeKey({ return: true }) }, a.ctx)
    expect(a.newChats).toEqual(['Kari'])
  })

  test('l on the `… N more` row expands that chat section', () => {
    const many = Array.from({ length: 12 }, (_, i) => chat(`d${i}`))
    const a = makeCtx({
      chats: many,
      settings: { chatListSort: 'recent', chatListGroupByType: true },
      cursor: 11, // section header (0) + 10 capped rows, then the `… 2 more` row
    })
    expect(handleListKeys({ input: 'l', key: makeKey() }, a.ctx)).toBe('handled')
    expect(a.store.get().expandedChatSections).toEqual({ oneOnOne: true })
    // Expanding must not also open a conversation.
    expect(a.store.get().focus).toEqual({ kind: 'list' })
  })

  test("h collapses the focused chat row's section and lands on its header", () => {
    const a = makeCtx({
      chats: [chat('a'), chat('b')],
      settings: {
        chatListSort: 'recent',
        chatListGroupByType: true,
        chatListCollapsedSections: {},
      },
      cursor: 1, // section header at 0, first chat at 1
    })
    expect(handleListKeys({ input: 'h', key: makeKey() }, a.ctx)).toBe('handled')
    expect(a.store.get().settings.chatListCollapsedSections).toEqual({ oneOnOne: true })
    expect(a.store.get().cursor).toBe(0)
  })

  test('h on a header stays put rather than collapsing the section above', () => {
    const a = makeCtx({
      chats: [chat('a')],
      settings: {
        chatListSort: 'recent',
        chatListGroupByType: true,
        chatListCollapsedSections: { oneOnOne: true },
      },
      cursor: 0,
    })
    // ctx carries the list-shaping settings; the handler reads and writes the
    // store's copy, so seed both.
    a.store.set((st) => ({
      settings: { ...st.settings, chatListCollapsedSections: { oneOnOne: true } },
    }))
    expect(handleListKeys({ input: 'h', key: makeKey() }, a.ctx)).toBe('handled')
    expect(a.store.get().settings.chatListCollapsedSections).toEqual({ oneOnOne: true })
    expect(a.store.get().cursor).toBe(0)
  })

  test('l on a collapsed header expands it and steps onto the first child', () => {
    const a = makeCtx({
      chats: [chat('a'), chat('b')],
      settings: {
        chatListSort: 'recent',
        chatListGroupByType: true,
        chatListCollapsedSections: { oneOnOne: true },
      },
      cursor: 0,
    })
    // ctx carries the list-shaping settings; the handler reads and writes the
    // store's copy, so seed both.
    a.store.set((st) => ({
      settings: { ...st.settings, chatListCollapsedSections: { oneOnOne: true } },
    }))
    expect(handleListKeys({ input: 'l', key: makeKey() }, a.ctx)).toBe('handled')
    expect(a.store.get().settings.chatListCollapsedSections).toEqual({})
    expect(a.store.get().cursor).toBe(1)
    // Expanding must not also open a conversation.
    expect(a.store.get().focus).toEqual({ kind: 'list' })
  })

  test('h on a collapsed team collapses Teams; l reopens it onto the first channel', () => {
    const settings = {
      chatListSort: 'recent' as const,
      chatListGroupByType: true,
      chatListCollapsedSections: { 'team:t1': true },
    }
    const a = makeCtx({
      chats: [chat('a')],
      teams: [
        { id: 't1', displayName: 'Contoso' },
        { id: 't2', displayName: 'Other' },
      ],
      channelsByTeam: { t2: [{ id: 'ch', displayName: 'General' }] },
      settings,
      cursor: 3, // [Direct, a, Teams, ▸ Contoso, Other, # General]
    })
    a.store.set((st) => ({ settings: { ...st.settings, ...settings } }))
    handleListKeys({ input: 'h', key: makeKey() }, a.ctx)
    expect(a.store.get().settings.chatListCollapsedSections).toEqual({
      'team:t1': true,
      teams: true,
    })
    expect(a.store.get().cursor).toBe(2)

    a.ctx.settings = a.store.get().settings
    a.ctx.cursor = 2
    handleListKeys({ input: 'l', key: makeKey() }, a.ctx)
    expect(a.store.get().settings.chatListCollapsedSections).toEqual({ 'team:t1': true })
    // The collapsed Contoso header is the first cursor stop under Teams.
    expect(a.store.get().cursor).toBe(3)
  })

  test('l on Teams skips an expanded team header to its first channel', () => {
    const settings = {
      chatListSort: 'recent' as const,
      chatListGroupByType: true,
      chatListCollapsedSections: { teams: true },
    }
    const a = makeCtx({
      chats: [chat('a')],
      teams: [{ id: 't1', displayName: 'Contoso' }],
      channelsByTeam: { t1: [{ id: 'ch', displayName: 'General' }] },
      settings,
      cursor: 2, // [Direct, a, ▸ Teams]
    })
    a.store.set((st) => ({ settings: { ...st.settings, ...settings } }))
    handleListKeys({ input: 'l', key: makeKey() }, a.ctx)
    expect(a.store.get().cursor).toBe(4) // [Direct, a, Teams, Contoso, # General]
  })
})

describe('list cursor follows its row', () => {
  test('j stores the row key; after a reorder ctrl+d targets that same chat', () => {
    const a = makeCtx()
    handleListKeys({ input: 'j', key: makeKey() }, a.ctx)
    expect(a.store.get().cursorKey).toBe('chat:b')
    // A poll moves b to the top. The stored index (1) now points at a.
    const { cursor, cursorKey } = a.store.get()
    const b = makeCtx({ chats: [chat('b'), chat('a'), chat('c')], cursor, cursorKey })
    handleListKeys({ input: 'd', key: makeKey({ ctrl: true }) }, b.ctx)
    expect(b.store.get().modal).toMatchObject({ kind: 'confirm-delete-chat', chatId: 'b' })
  })
})

describe('ctrl+d delete chat', () => {
  test('opens the confirm modal for the row under the cursor', () => {
    const a = makeCtx({ cursor: 1 })
    expect(handleListKeys({ input: 'd', key: makeKey({ ctrl: true }) }, a.ctx)).toBe('handled')
    expect(a.store.get().modal).toMatchObject({ kind: 'confirm-delete-chat', chatId: 'b' })
  })

  test('targets the open chat when one is focused, not the cursor row', () => {
    const a = makeCtx({ cursor: 0, focus: { kind: 'chat', chatId: 'c' } })
    handleListKeys({ input: 'd', key: makeKey({ ctrl: true }) }, a.ctx)
    expect(a.store.get().modal).toMatchObject({ kind: 'confirm-delete-chat', chatId: 'c' })
  })

  test('plain d still half-pages instead of deleting', () => {
    const a = makeCtx({ cursor: 0 })
    handleListKeys({ input: 'd', key: makeKey() }, a.ctx)
    expect(a.store.get().modal).toBeNull()
    expect(a.store.get().cursor).toBeGreaterThan(0)
  })
})

describe('unified sidebar (M2 F.3)', () => {
  type Slice = Partial<AccountSlice>
  // alpha in front, beta in the background, both with the same chat ids.
  // Keys are pressed against a ctx read from the store each time, as App does.
  function unified(beta: Slice = {}, alpha: Slice = {}, settings: Partial<Settings> = {}) {
    const store = createAppStore()
    openAccount(store, accountRef('alpha'), { foreground: true }).set({
      chats: [chat('a'), chat('b')],
      ...alpha,
    })
    openAccount(store, accountRef('beta'), { foreground: false }).set({
      chats: [chat('a'), chat('b')],
      ...beta,
    })
    store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha', 'beta'], ...settings } }))
    const swaps: string[] = []
    const prompts: string[] = []
    const press = (input: string, key: Partial<Key> = {}) => {
      const s = store.get()
      return handleListKeys(
        { input, key: makeKey(key) },
        {
          store,
          me: s.me,
          chats: s.chats,
          teams: s.teams,
          channelsByTeam: s.channelsByTeam,
          settings: s.settings,
          filter: s.filter,
          expandedChatSections: s.expandedChatSections,
          cursor: s.cursor,
          cursorKey: s.cursorKey,
          focus: s.focus,
          exit: () => {},
          refresh: () => {},
          hardRefresh: () => {},
          openNewChatPrompt: (q) => prompts.push(q ?? ''),
          toForeground: (alias) => {
            swaps.push(alias)
            setForeground(store, accountRef(alias).id, { restoreUi: false })
          },
        },
      )
    }
    return { store, swaps, prompts, press }
  }
  const alphaId = accountRef('alpha').id
  const betaId = accountRef('beta').id

  test('j crosses into the next account; Enter brings it to the front, then focuses', () => {
    const u = unified()
    // account:alpha, alpha a, alpha b, account:beta, beta a
    for (let i = 0; i < 4; i++) u.press('j')
    expect(u.store.get().cursorKey).toBe(`${betaId}/chat:a`)
    u.press('', { return: true })
    expect(u.swaps).toEqual(['beta'])
    const s = u.store.get()
    expect(s.account?.id).toBe(betaId)
    expect(s.focus).toEqual({ kind: 'chat', chatId: 'a' })
    // The list cursor stays on the row it opened.
    expect(s.cursorKey).toBe(`${betaId}/chat:a`)
    // A row of the foreground account opens without a swap.
    u.press('h')
    u.store.set({ focus: { kind: 'list' } })
    u.press('j')
    u.press('', { return: true })
    expect(u.swaps).toEqual(['beta'])
    expect(u.store.get().focus).toEqual({ kind: 'chat', chatId: 'b' })
  })

  test('f favorites the row in its own account, without a swap; the cursor follows it', () => {
    const u = unified()
    // account:alpha, alpha a, alpha b, account:beta, beta a, beta b
    for (let i = 0; i < 5; i++) u.press('j')
    expect(u.store.get().cursorKey).toBe(`${betaId}/chat:b`)
    u.press('f')
    expect(u.swaps).toEqual([])
    expect(u.store.get().account?.id).toBe(alphaId)
    expect(u.store.get().settings.favoritesByAccount).toEqual({ beta: ['chat:b'] })
    const now = visibleList(unifiedListInput(u.store.get())!)
    const at = now.findIndex((it) => it.kind === 'section' && it.alias === 'beta')
    expect(at).toBe(4)
    expect(now[at + 1]).toMatchObject({ kind: 'chat', alias: 'beta', favorite: 'favorites' })
    expect(resolveCursor(now, now.length, u.store.get().cursorKey, u.store.get().cursor)).toBe(
      at + 1,
    )
  })

  test('Ctrl+F moves the row to the cross-account block; h / Enter collapse and reopen it', () => {
    const u = unified()
    // account:alpha, alpha a, alpha b, account:beta, beta a
    for (let i = 0; i < 4; i++) u.press('j')
    u.press('f', { ctrl: true })
    expect(u.swaps).toEqual([])
    expect(u.store.get().settings.crossAccountFavorites).toEqual({ beta: ['chat:a'] })
    expect(u.store.get().settings.favoritesByAccount).toEqual({})
    const list = () => visibleList(unifiedListInput(u.store.get())!)
    expect(list()[0]).toMatchObject({ kind: 'section', section: 'crossFavorites' })
    expect(list()[1]).toMatchObject({ kind: 'chat', alias: 'beta', favorite: 'crossFavorites' })
    // The cursor followed the row to the top.
    const at = () =>
      resolveCursor(list(), list().length, u.store.get().cursorKey, u.store.get().cursor)
    expect(at()).toBe(1)
    // h collapses the block onto its header; Enter reopens it onto the row.
    u.press('h')
    expect(u.store.get().settings.chatListCollapsedSections).toEqual({ crossFavorites: true })
    expect(at()).toBe(0)
    u.press('', { return: true })
    expect(u.store.get().settings.chatListCollapsedSections).toEqual({})
    expect(at()).toBe(1)
    // Enter opens it in its own account.
    u.press('', { return: true })
    expect(u.swaps).toEqual(['beta'])
    expect(u.store.get().focus).toEqual({ kind: 'chat', chatId: 'a' })
  })

  test('m flips the row’s own account’s unread mark, not the foreground’s', () => {
    const u = unified()
    for (let i = 0; i < 4; i++) u.press('j')
    u.press('m')
    const s = u.store.get()
    expect(s.account?.id).toBe(alphaId)
    expect(s.unreadByChatId.a).toBeUndefined()
    expect(s.backgroundAccounts[betaId]!.unreadByChatId.a?.unreadCount).toBe(1)
    expect(u.swaps).toEqual([])
  })

  test('. and ctrl+d on another account’s row name that account', () => {
    const u = unified()
    for (let i = 0; i < 4; i++) u.press('j')
    u.press('.')
    expect(u.store.get().modal).toMatchObject({
      kind: 'context-menu',
      target: { kind: 'chat', chatId: 'a', alias: 'beta' },
    })
    u.store.set({ modal: null, inputZone: 'list' })
    u.press('d', { ctrl: true })
    expect(u.store.get().modal).toMatchObject({
      kind: 'confirm-delete-chat',
      chatId: 'a',
      alias: 'beta',
    })
    expect(u.swaps).toEqual([])
  })

  test('h collapses an account header; Enter expands it and moves to its first row', () => {
    const u = unified()
    expect(u.store.get().cursor).toBe(0)
    u.press('h')
    expect(u.store.get().settings.chatListCollapsedSections).toEqual({ 'account:alpha': true })
    u.press('', { return: true })
    expect(u.store.get().settings.chatListCollapsedSections).toEqual({})
    expect(u.store.get().cursorKey).toBe(`${alphaId}/chat:a`)
    // h on a chat collapses its account (ungrouped: no section) onto its header.
    u.press('h')
    expect(u.store.get().cursorKey).toBe(`account:${alphaId}`)
  })

  test('Enter on an empty account stays on its header; on a failed one opens Accounts', () => {
    const empty = unified({ chats: [] })
    for (let i = 0; i < 3; i++) empty.press('j')
    empty.press('', { return: true })
    expect(empty.store.get().cursorKey).toBe(`account:${betaId}`)
    expect(empty.store.get().modal).toBeNull()

    const failed = unified({ chats: [], conn: 'authError' })
    for (let i = 0; i < 3; i++) failed.press('j')
    failed.press('', { return: true })
    expect(failed.store.get().modal).toMatchObject({ kind: 'accounts', mode: 'list', cursor: 1 })
    expect(failed.swaps).toEqual([])
  })

  test('reopening a section writes false under the account’s key over a legacy key', () => {
    const u = unified(
      { teams: [{ id: 't1', displayName: 'T' }], channelsByTeam: { t1: [] } },
      {},
      { chatListCollapsedSections: { 'team:t1': true } },
    )
    // account:alpha, a, b, account:beta, a, b, beta team:t1 (collapsed)
    for (let i = 0; i < 6; i++) u.press('j')
    expect(u.store.get().cursorKey).toBe(`${betaId}/team:t1`)
    u.press('', { return: true })
    expect(u.store.get().settings.chatListCollapsedSections).toEqual({
      'team:t1': true,
      'beta/team:t1': false,
    })
  })

  test('… N more expands the row’s own account', () => {
    const many = Array.from({ length: CHAT_SECTION_CAP + 1 }, (_, i) => chat(`c${i}`))
    const u = unified({ chats: many }, { chats: many }, { chatListGroupByType: true })
    const more = () =>
      visibleList(unifiedListInput(u.store.get())!).findIndex(
        (it) => it.kind === 'more' && it.alias === 'beta',
      )
    u.store.set(cursorAt(visibleList(unifiedListInput(u.store.get())!), more()))
    u.press('', { return: true })
    const s = u.store.get()
    expect(s.backgroundAccounts[betaId]!.expandedChatSections).toEqual({ oneOnOne: true })
    expect(s.expandedChatSections).toEqual({})
    expect(more()).toBe(-1)
  })

  test('a swap that shows auth-expired stops there: no focus, no prompt behind it', () => {
    const u = unified()
    // Like the manager: an account that failed for auth comes to the front
    // with its auth-expired modal.
    const press = (input: string, key: Partial<Key> = {}) => {
      const s = u.store.get()
      return handleListKeys(
        { input, key: makeKey(key) },
        {
          store: u.store,
          chats: s.chats,
          teams: s.teams,
          channelsByTeam: s.channelsByTeam,
          settings: s.settings,
          filter: s.filter,
          expandedChatSections: s.expandedChatSections,
          cursor: s.cursor,
          cursorKey: s.cursorKey,
          focus: s.focus,
          exit: () => {},
          refresh: () => {},
          hardRefresh: () => {},
          openNewChatPrompt: (q) => u.prompts.push(q ?? ''),
          toForeground: (alias) => {
            setForeground(u.store, accountRef(alias).id, { restoreUi: false })
            u.store.set({
              modal: { kind: 'auth-expired', profile: alias, message: 'expired', status: 'idle' },
              inputZone: 'menu',
            })
          },
        },
      )
    }
    for (let i = 0; i < 4; i++) u.press('j')
    press('', { return: true })
    expect(u.store.get().focus).toEqual({ kind: 'list' })
    expect(u.store.get()).toMatchObject({ modal: { kind: 'auth-expired' }, inputZone: 'menu' })
    // Back on alpha, n on a beta row: the prompt does not open behind the modal.
    setForeground(u.store, alphaId, { restoreUi: false })
    press('n')
    expect(u.prompts).toEqual([])
  })

  test('n brings the account under the cursor to the front before the prompt', () => {
    const u = unified()
    for (let i = 0; i < 3; i++) u.press('j')
    u.press('n')
    expect(u.swaps).toEqual(['beta'])
    expect(u.prompts).toEqual([''])
    expect(u.store.get().account?.id).toBe(betaId)
  })
})

describe('f: favorites', () => {
  test('single mode: f moves the cursor row into Favorites and the cursor goes with it', () => {
    const store = createAppStore(accountRef(null))
    const press = (input: string, key: Partial<Key> = {}) => {
      const s = store.get()
      const favorites = favoritesFor(s.settings, s.account)
      handleListKeys(
        { input, key: makeKey(key) },
        {
          ...makeCtx().ctx,
          store,
          chats: [chat('a'), chat('b'), chat('c')],
          settings: s.settings,
          favorites,
          cursor: s.cursor,
          cursorKey: s.cursorKey,
        },
      )
    }
    const list = () => {
      const s = store.get()
      return visibleList({
        chats: [chat('a'), chat('b'), chat('c')],
        teams: [],
        channelsByTeam: {},
        settings: s.settings,
        favorites: favoritesFor(s.settings, s.account),
      })
    }
    press('j') // cursor on b
    press('f')
    expect(store.get().settings.favoritesByAccount).toEqual({ '': ['chat:b'] })
    const now = list()
    expect(now.map((it) => it.kind)).toEqual(['section', 'chat', 'chat', 'chat'])
    expect(store.get().cursorKey).toBe('chat:b')
    expect(resolveCursor(now, now.length, store.get().cursorKey, store.get().cursor)).toBe(1)
    // f again: back to its normal place, Favorites gone.
    press('f')
    expect(store.get().settings.favoritesByAccount).toEqual({})
    expect(list().some((it) => it.kind === 'section')).toBe(false)
  })

  test('f on a header or a more row does nothing; F is not f', () => {
    const store = createAppStore(accountRef(null))
    const { ctx } = makeCtx({
      store,
      settings: { chatListSort: 'recent', chatListGroupByType: true },
    })
    // Cursor on the Direct header (expanded headers are skipped by j/k,
    // but the stored index can sit on one).
    expect(handleListKeys({ input: 'f', key: makeKey() }, { ...ctx, cursor: 0 })).toBe('handled')
    expect(store.get().settings.favoritesByAccount).toEqual({})
    handleListKeys({ input: 'F', key: makeKey({ shift: true }) }, { ...ctx, cursor: 1 })
    expect(store.get().settings.favoritesByAccount).toEqual({})
  })
})
