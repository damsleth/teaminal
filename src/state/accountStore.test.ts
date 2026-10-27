import { describe, expect, test } from 'bun:test'
import { accountRef } from '../account'
import { accountStore } from './accountStore'
import { ACCOUNT_KEYS, createAppStore, initialAccountState, resetAccountScopedState } from './store'

const chat = (id: string) => ({ id, chatType: 'oneOnOne' as const, createdDateTime: '2026-01-01' })

function storeFor(profile: string | null) {
  const store = createAppStore()
  store.set({ account: accountRef(profile) })
  return store
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

  test('subscribe fires on account-field changes only, and stops when stale', () => {
    const store = storeFor('a')
    const acc = accountStore(store)
    let calls = 0
    acc.subscribe(() => calls++)
    store.set({ filter: 'x' })
    expect(calls).toBe(0)
    acc.set({ unreadMentionCount: 3 })
    expect(calls).toBe(1)
    resetAccountScopedState(store, accountRef('b'))
    store.set({ unreadMentionCount: 5 })
    expect(calls).toBe(1)
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
