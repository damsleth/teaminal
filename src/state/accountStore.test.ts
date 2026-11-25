import { describe, expect, test } from 'bun:test'
import { accountRef } from '../account'
import {
  accountStore,
  accountStoreFor,
  closeAccount,
  openAccount,
  setForeground,
} from './accountStore'
import { buildSelectableList, resolveCursor, selectableKey } from './selectables'
import {
  ACCOUNT_KEYS,
  accountSlice,
  createAppStore,
  initialAccountState,
  resetAccountScopedState,
  type AppState,
  type Store,
} from './store'

const chat = (id: string) => ({ id, chatType: 'oneOnOne' as const, createdDateTime: '2026-01-01' })

function storeFor(profile: string | null) {
  return createAppStore(accountRef(profile))
}

describe('accountStore', () => {
  test('writes account fields while current', () => {
    const store = storeFor('a')
    const acc = accountStore(store)
    expect(acc.set({ chats: [chat('c1')] })).toBe(true)
    expect(store.get().chats.map((c) => c.id)).toEqual(['c1'])
  })

  test('ignores global keys in a patch', () => {
    const store = storeFor('a')
    const acc = accountStore(store)
    acc.set({ chats: [chat('c1')], filter: 'x', focus: { kind: 'chat', chatId: 'c1' } } as never)
    expect(store.get().chats).toHaveLength(1)
    expect(store.get().filter).toBe('')
    expect(store.get().focus).toEqual({ kind: 'list' })
  })

  test('drops writes after a reset to another account', () => {
    const store = storeFor('a')
    const acc = accountStore(store)
    resetAccountScopedState(store, accountRef('b'))
    expect(acc.isCurrent()).toBe(false)
    expect(acc.set({ chats: [chat('leak')] })).toBe(false)
    expect(acc.set(() => ({ chats: [chat('leak')] }))).toBe(false)
    expect(store.get().chats).toEqual([])
  })

  test('drops writes from a previous incarnation of the same account (A -> B -> A)', () => {
    const store = storeFor('a')
    const old = accountStore(store)
    resetAccountScopedState(store, accountRef('b'))
    resetAccountScopedState(store, accountRef('a'))
    const fresh = accountStore(store)
    expect(old.set({ chats: [chat('leak')] })).toBe(false)
    expect(fresh.set({ chats: [chat('ok')] })).toBe(true)
    expect(store.get().chats.map((c) => c.id)).toEqual(['ok'])
  })

  test('refuses to bind before the store has an account', () => {
    expect(() => accountStore(createAppStore())).toThrow()
  })

  test('subscribe fires on any change while current, and stops when stale', () => {
    const store = storeFor('a')
    const acc = accountStore(store)
    let calls = 0
    acc.subscribe(() => calls++)
    // global keys too: the poller wakes on focus changes
    store.set({ focus: { kind: 'chat', chatId: 'c1' } })
    acc.set({ unreadMentionCount: 3 })
    expect(calls).toBe(2)
    resetAccountScopedState(store, accountRef('b'))
    calls = 0
    store.set({ unreadMentionCount: 5 })
    expect(calls).toBe(0)
  })
})

describe('initialAccountState', () => {
  test('carries the ref and every account key', () => {
    const ref = accountRef(null)
    const s = initialAccountState(ref)
    expect(s.ref).toBe(ref)
    expect(Object.keys(s).sort()).toEqual(['ref', ...ACCOUNT_KEYS].sort())
    expect(s.chats).toEqual([])
    expect(s.conn).toBe('connecting')
  })

  test('resetAccountScopedState binds the new account and bumps the generation', () => {
    const store = storeFor('a')
    const before = store.get().accountGeneration
    resetAccountScopedState(store, accountRef('b'))
    expect(store.get().account?.id).toBe(accountRef('b').id)
    expect(store.get().accountGeneration).toBe(before + 1)
  })
})

const alice = accountRef('alice')
const bob = accountRef('bob')

// Alice in the foreground, Bob open in the background.
function twoSlots() {
  const store = createAppStore(alice)
  const a = accountStore(store)
  const b = openAccount(store, bob, { foreground: false })
  return { store, a, b }
}

const msg = (id: string, content: string) => ({
  id,
  createdDateTime: '2026-01-01T00:00:00Z',
  body: { contentType: 'text' as const, content },
})

function generations(store: Store<AppState>) {
  const s = store.get()
  return { counter: s.accountGeneration, byId: s.generationById }
}

describe('account slots', () => {
  test('writes through each handle land only in its own slice, even with colliding ids', () => {
    const { store, a, b } = twoSlots()
    expect(a.isForeground()).toBe(true)
    expect(b.isForeground()).toBe(false)

    const bobBefore = store.get().backgroundAccounts[bob.id]
    a.set({
      chats: [chat('c1')],
      messagesByConvo: { 'chat:c1': [msg('m1', 'from alice')] },
    })
    expect(store.get().backgroundAccounts[bob.id]).toBe(bobBefore!)

    const aliceChats = store.get().chats
    const aliceMessages = store.get().messagesByConvo
    b.set({
      chats: [chat('c1')],
      messagesByConvo: { 'chat:c1': [msg('m1', 'FROM BOB')] },
    })
    expect(store.get().chats).toBe(aliceChats)
    expect(store.get().messagesByConvo).toBe(aliceMessages)
    expect(store.get().messagesByConvo['chat:c1']![0]!.body.content).toBe('from alice')
    expect(accountSlice(store.get(), bob.id)!.messagesByConvo['chat:c1']![0]!.body.content).toBe(
      'FROM BOB',
    )
    expect(b.get().messagesByConvo['chat:c1']![0]!.body.content).toBe('FROM BOB')
    expect(accountSlice(store.get(), alice.id)).toBe(store.get())
    expect(accountSlice(store.get(), accountRef('carol').id)).toBeUndefined()
  })

  test('background set: updaters see the handle view; a no-op does not notify', () => {
    const { store, b } = twoSlots()
    store.set({ chats: [chat('alice-only')] })
    b.set((s) => ({ chats: [...s.chats, chat('b1')] }))
    expect(b.get().chats.map((c) => c.id)).toEqual(['b1'])
    let calls = 0
    store.subscribe(() => calls++)
    const chats = b.get().chats
    expect(b.set({ chats, me: undefined })).toBe(true)
    expect(calls).toBe(0)
  })

  test('setForeground A -> B -> A swaps the flat fields, clears optional keys, keeps generations', () => {
    const { store, a, b } = twoSlots()
    a.set({
      me: {
        id: 'alice-id',
        displayName: 'Alice',
        userPrincipalName: 'alice@example.com',
        mail: null,
      },
      capabilities: {} as never,
      myPresence: { id: 'alice-id', availability: 'Available', activity: 'Available' },
      lastListPollAt: new Date(0),
      activitySyncState: 'cursor-a',
      chats: [chat('c1')],
    })
    b.set({ chats: [chat('c1'), chat('c2')] })
    const gens = generations(store)

    setForeground(store, bob.id)
    let s = store.get()
    expect(s.account).toBe(bob)
    expect(s.chats.map((c) => c.id)).toEqual(['c1', 'c2'])
    for (const k of [
      'me',
      'capabilities',
      'myPresence',
      'lastListPollAt',
      'activitySyncState',
    ] as const) {
      expect(s[k]).toBeUndefined()
    }
    expect(s.backgroundAccounts[alice.id]!.me?.displayName).toBe('Alice')
    expect(s.backgroundAccounts[bob.id]).toBeUndefined()
    expect(generations(store)).toEqual(gens)
    expect(a.isCurrent()).toBe(true)
    expect(b.isForeground()).toBe(true)

    // A handle taken before the swap still writes to its own account.
    a.set({ unreadMentionCount: 7 })
    expect(store.get().unreadMentionCount).toBe(0)
    expect(store.get().backgroundAccounts[alice.id]!.unreadMentionCount).toBe(7)

    setForeground(store, alice.id)
    s = store.get()
    expect(s.account).toBe(alice)
    expect(s.me?.displayName).toBe('Alice')
    expect(s.activitySyncState).toBe('cursor-a')
    expect(s.unreadMentionCount).toBe(7)
    expect(s.chats.map((c) => c.id)).toEqual(['c1'])
    expect(s.backgroundAccounts[bob.id]!.chats.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(generations(store)).toEqual(gens)

    // Already foreground: no-op. Unknown id: throws.
    const before = store.get()
    setForeground(store, alice.id)
    expect(store.get()).toBe(before)
    expect(() => setForeground(store, accountRef('carol').id)).toThrow()
  })

  test('a swap restores focus and cursorKey per account and clears the rest of the UI group', () => {
    const { store } = twoSlots()
    store.set({ chats: [chat('c1'), chat('c2')] })
    store.set({
      focus: { kind: 'chat', chatId: 'c2' },
      cursor: 1,
      cursorKey: 'chat:c2',
      filter: 'c',
      modal: { kind: 'keybinds' },
      inputZone: 'menu',
      messageSearchQuery: 'q',
      editingMessageId: 'm1',
      focusedAttachmentIndex: 2,
      chatListCollapsed: true,
    })

    setForeground(store, bob.id)
    let s = store.get()
    expect(s.focus).toEqual({ kind: 'list' })
    expect(s.cursor).toBe(0)
    expect(s.cursorKey).toBeNull()
    expect(s.filter).toBe('')
    expect(s.modal).toBeNull()
    expect(s.inputZone).toBe('list')
    expect(s.messageSearchQuery).toBe('')
    expect(s.editingMessageId).toBeNull()
    expect(s.focusedAttachmentIndex).toBe(0)
    expect(s.chatListCollapsed).toBe(true)
    store.set({ focus: { kind: 'chat', chatId: 'b-chat' } })

    setForeground(store, alice.id)
    s = store.get()
    expect(s.focus).toEqual({ kind: 'chat', chatId: 'c2' })
    expect(s.cursorKey).toBe('chat:c2')
    expect(s.cursor).toBe(1)
    expect(s.uiByAccount[bob.id]!.focus).toEqual({ kind: 'chat', chatId: 'b-chat' })

    // A restored cursorKey whose row vanished falls back to the index.
    const remaining = [chat('c1')]
    store.set({ chats: remaining })
    const visible = buildSelectableList(store.get())
    expect(visible.map(selectableKey)).not.toContain('chat:c2')
    expect(resolveCursor(visible, visible.length, s.cursorKey, s.cursor)).toBe(0)
  })

  test('restoreUi: false keeps the list cursor and filter, focus goes to the list', () => {
    const { store } = twoSlots()
    store.set({
      focus: { kind: 'chat', chatId: 'c1' },
      cursor: 3,
      cursorKey: 'chat:x',
      filter: 'f',
    })
    setForeground(store, bob.id, { restoreUi: false })
    const s = store.get()
    expect(s.focus).toEqual({ kind: 'list' })
    expect(s.cursor).toBe(3)
    expect(s.cursorKey).toBe('chat:x')
    expect(s.filter).toBe('f')
  })

  test('a draft typed in A survives a swap to B and back', () => {
    const { store } = twoSlots()
    store.set({ draftsByConvo: { 'chat:c1': 'half-typed' } })
    setForeground(store, bob.id)
    expect(store.get().draftsByConvo).toEqual({})
    setForeground(store, alice.id)
    expect(store.get().draftsByConvo).toEqual({ 'chat:c1': 'half-typed' })
  })

  test('background view masks the Global-UI group and is memoized', () => {
    const { store, b } = twoSlots()
    store.set({ focus: { kind: 'chat', chatId: 'c1' }, filter: 'x', modal: { kind: 'keybinds' } })
    const view = b.get()
    expect(view.focus.kind).toBe('list')
    expect(view.filter).toBe('')
    expect(view.modal).toBeNull()
    expect(view.account).toBe(bob)
    expect(view.settings).toBe(store.get().settings)
    expect(b.get()).toBe(view)

    // A root focus change does not change the background view's focus...
    store.set({ focus: { kind: 'chat', chatId: 'c2' } })
    expect(b.get()).not.toBe(view)
    expect(b.get().focus).toBe(view.focus)

    // ...a swap does (Bob comes back to his remembered chat).
    setForeground(store, bob.id)
    store.set({ focus: { kind: 'chat', chatId: 'c1' } })
    setForeground(store, alice.id)
    const seen: string[] = []
    b.subscribe((s) => seen.push(s.focus.kind))
    setForeground(store, bob.id)
    expect(b.get().focus).toEqual({ kind: 'chat', chatId: 'c1' })
    expect(seen).toEqual(['chat'])
  })

  test('closeAccount: late writes drop, get() is the empty view; re-open does not revive old handles', () => {
    const { store, a, b } = twoSlots()
    b.set({ chats: [chat('b1')] })
    closeAccount(store, bob.id)
    expect(b.isCurrent()).toBe(false)
    expect(b.set({ chats: [chat('leak')] })).toBe(false)
    expect(store.get().backgroundAccounts[bob.id]).toBeUndefined()
    expect(store.get().generationById[bob.id]).toBeUndefined()
    const empty = b.get()
    expect(empty.chats).toEqual([])
    expect(empty.account).toBe(bob)
    expect(empty.focus.kind).toBe('list')
    expect(empty.settings).toBe(store.get().settings)
    expect(() => accountStoreFor(store, bob)).toThrow()

    const fresh = openAccount(store, bob, { foreground: false })
    expect(b.isCurrent()).toBe(false)
    expect(b.set({ chats: [chat('leak')] })).toBe(false)
    expect(fresh.get().chats).toEqual([])

    // The foreground cannot close while another slot is open.
    expect(() => closeAccount(store, alice.id)).toThrow()
    closeAccount(store, bob.id)
    store.set({ focus: { kind: 'chat', chatId: 'c1' }, me: { id: 'x' } as never })
    closeAccount(store, alice.id)
    const s = store.get()
    expect(s.account).toBeNull()
    expect(s.me).toBeUndefined()
    expect(s.focus).toEqual({ kind: 'list' })
    expect(s.generationById).toEqual({})
    expect(a.isCurrent()).toBe(false)
  })

  test('openAccount: re-open replaces the slot; foreground needs a free foreground', () => {
    const { store, a } = twoSlots()
    a.set({ chats: [chat('c1')] })
    expect(() => openAccount(store, accountRef('carol'), { foreground: true })).toThrow()
    expect(() => openAccount(store, alice, { foreground: false })).toThrow()
    const reopened = openAccount(store, alice, { foreground: true })
    expect(a.isCurrent()).toBe(false)
    expect(reopened.isForeground()).toBe(true)
    expect(store.get().chats).toEqual([])
    expect(store.get().generationById[bob.id]).toBeDefined()
  })

  test('resetAccountScopedState closes every slot and opens the account alone', () => {
    const { store, a, b } = twoSlots()
    let calls = 0
    store.subscribe(() => calls++)
    resetAccountScopedState(store, bob)
    expect(calls).toBe(1)
    const s = store.get()
    expect(s.account).toBe(bob)
    expect(s.backgroundAccounts).toEqual({})
    expect(s.uiByAccount).toEqual({})
    expect(Object.keys(s.generationById)).toEqual([bob.id])
    expect(a.isCurrent()).toBe(false)
    expect(b.isCurrent()).toBe(false)
    expect(accountStore(store).isForeground()).toBe(true)
  })
})
