import { describe, expect, test } from 'bun:test'
import {
  createAppStore,
  type Focus,
  focusKey,
  initialAppState,
  Store,
} from './store'

describe('Store basics', () => {
  test('get() returns current state', () => {
    const s = new Store({ count: 0 })
    expect(s.get()).toEqual({ count: 0 })
  })

  test('set() merges a partial patch', () => {
    const s = new Store({ count: 0, name: 'x' })
    s.set({ count: 1 })
    expect(s.get()).toEqual({ count: 1, name: 'x' })
  })

  test('set() with an updater function gets current state', () => {
    const s = new Store({ count: 0 })
    s.set((cur) => ({ count: cur.count + 5 }))
    expect(s.get().count).toBe(5)
  })

  test('returns a new state object reference on change (immutability)', () => {
    const s = new Store({ count: 0 })
    const before = s.get()
    s.set({ count: 1 })
    const after = s.get()
    expect(after).not.toBe(before)
    expect(before.count).toBe(0) // before reference is unchanged
  })

  test('skips listeners when no field actually changes', () => {
    const s = new Store({ count: 0 })
    let calls = 0
    s.subscribe(() => {
      calls++
    })
    s.set({ count: 0 })
    expect(calls).toBe(0)
  })

  test('skips undefined fields in the patch (preserves existing value)', () => {
    const s = new Store<{ count: number; name?: string }>({ count: 0, name: 'x' })
    s.set({ name: undefined })
    expect(s.get().name).toBe('x')
  })

  test('fires listeners synchronously after change', () => {
    const s = new Store({ count: 0 })
    const seen: number[] = []
    s.subscribe((state) => seen.push(state.count))
    s.set({ count: 1 })
    s.set({ count: 2 })
    expect(seen).toEqual([1, 2])
  })

  test('multiple listeners all fire', () => {
    const s = new Store({ count: 0 })
    let a = 0
    let b = 0
    s.subscribe(() => {
      a++
    })
    s.subscribe(() => {
      b++
    })
    s.set({ count: 1 })
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  test('unsubscribe stops further notifications', () => {
    const s = new Store({ count: 0 })
    let calls = 0
    const off = s.subscribe(() => {
      calls++
    })
    s.set({ count: 1 })
    off()
    s.set({ count: 2 })
    expect(calls).toBe(1)
  })
})

describe('focusKey', () => {
  test('returns null for list focus', () => {
    expect(focusKey({ kind: 'list' })).toBeNull()
  })

  test('encodes chat focus with chat: prefix', () => {
    expect(focusKey({ kind: 'chat', chatId: '19:abc' })).toBe('chat:19:abc')
  })

  test('encodes channel focus with team and channel ids', () => {
    expect(
      focusKey({ kind: 'channel', teamId: 'team-1', channelId: '19:gen' }),
    ).toBe('channel:team-1:19:gen')
  })

  test('different focus shapes never collide', () => {
    const a = focusKey({ kind: 'chat', chatId: 'x' })
    const b = focusKey({ kind: 'channel', teamId: 'y', channelId: 'x' })
    const c = focusKey({ kind: 'channel', teamId: 'x', channelId: 'y' })
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe('createAppStore', () => {
  test('returns a Store seeded with the initial AppState', () => {
    const s = createAppStore()
    expect(s.get()).toEqual(initialAppState())
    expect(s.get().focus).toEqual({ kind: 'list' })
    expect(s.get().chats).toEqual([])
    expect(s.get().conn).toBe('connecting')
  })

  test('focus updates fire listeners', () => {
    const s = createAppStore()
    const focuses: Focus[] = []
    s.subscribe((state) => focuses.push(state.focus))
    s.set({ focus: { kind: 'chat', chatId: 'c1' } })
    s.set({ focus: { kind: 'channel', teamId: 't', channelId: 'c' } })
    s.set({ focus: { kind: 'list' } })
    expect(focuses).toEqual([
      { kind: 'chat', chatId: 'c1' },
      { kind: 'channel', teamId: 't', channelId: 'c' },
      { kind: 'list' },
    ])
  })
})
