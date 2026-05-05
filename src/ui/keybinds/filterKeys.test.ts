import { describe, expect, test } from 'bun:test'
import type { Key } from 'ink'
import { handleFilterKeys, type FilterKeysCtx } from './filterKeys'
import { createAppStore } from '../../state/store'

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

function makeCtx(opts: { filter?: string; openOnEnter?: (q: string) => void }): {
  ctx: FilterKeysCtx
  store: ReturnType<typeof createAppStore>
  openCalls: string[]
} {
  const store = createAppStore()
  const openCalls: string[] = []
  const ctx: FilterKeysCtx = {
    store,
    filter: opts.filter ?? '',
    me: undefined,
    chats: [],
    teams: [],
    channelsByTeam: {},
    openNewChatPrompt: (q) => {
      openCalls.push(q)
      opts.openOnEnter?.(q)
    },
  }
  return { ctx, store, openCalls }
}

describe('handleFilterKeys', () => {
  test('typing appends to the filter buffer', () => {
    const { ctx, store } = makeCtx({ filter: 'foo' })
    expect(handleFilterKeys({ input: 'a', key: makeKey() }, ctx)).toBe('handled')
    expect(store.get().filter).toBe('fooa')
  })

  test('Backspace removes one character', () => {
    const { ctx, store } = makeCtx({ filter: 'foo' })
    handleFilterKeys({ input: '', key: makeKey({ backspace: true }) }, ctx)
    expect(store.get().filter).toBe('fo')
  })

  test('Esc clears filter, returns to list, resets cursor', () => {
    const store = createAppStore()
    store.set({ inputZone: 'filter', filter: 'foo', cursor: 5 })
    const ctx: FilterKeysCtx = {
      store,
      filter: 'foo',
      chats: [],
      teams: [],
      channelsByTeam: {},
      openNewChatPrompt: () => {},
    }
    handleFilterKeys({ input: '', key: makeKey({ escape: true }) }, ctx)
    expect(store.get().filter).toBe('')
    expect(store.get().inputZone).toBe('list')
    expect(store.get().cursor).toBe(0)
  })

  test('Enter with no candidates commits the filter and returns to list', () => {
    const { ctx, store } = makeCtx({ filter: 'something-not-a-name' })
    handleFilterKeys({ input: '', key: makeKey({ return: true }) }, ctx)
    expect(store.get().inputZone).toBe('list')
    expect(store.get().cursor).toBe(0)
    expect(store.get().filter).toBe('')
  })

  test('Enter on a name-shaped filter with no list match opens the new-chat prompt', () => {
    const { ctx, openCalls } = makeCtx({ filter: 'Carl' })
    handleFilterKeys({ input: '', key: makeKey({ return: true }) }, ctx)
    expect(openCalls).toEqual(['Carl'])
  })

  test('control / meta keys are not added to the filter buffer', () => {
    const { ctx, store } = makeCtx({ filter: '' })
    handleFilterKeys({ input: 'c', key: makeKey({ ctrl: true }) }, ctx)
    expect(store.get().filter).toBe('')
  })
})
