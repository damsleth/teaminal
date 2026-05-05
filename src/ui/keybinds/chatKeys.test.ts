import { describe, expect, test } from 'bun:test'
import type { Key } from 'ink'
import { handleChatKeys, type ChatKeysCtx } from './chatKeys'
import { createAppStore } from '../../state/store'
import type { Focus } from '../../state/store'

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

function makeCtx(
  focus: Focus,
  opts?: Partial<ChatKeysCtx>,
): {
  ctx: ChatKeysCtx
  store: ReturnType<typeof createAppStore>
  movements: number[]
  bottomCalls: number
  loadOlderCalls: number
} {
  const store = createAppStore()
  const movements: number[] = []
  let bottomCalls = 0
  let loadOlderCalls = 0
  const ctx: ChatKeysCtx = {
    store,
    focus,
    activeMessageCursor: 5,
    moveMessageCursor: (d) => movements.push(d),
    jumpMessageBottom: () => {
      bottomCalls++
    },
    tryLoadOlder: () => {
      loadOlderCalls++
    },
    ...opts,
  }
  return {
    ctx,
    store,
    movements,
    get bottomCalls() {
      return bottomCalls
    },
    get loadOlderCalls() {
      return loadOlderCalls
    },
  }
}

const CHAT_FOCUS: Focus = { kind: 'chat', chatId: 'c1' }

describe('handleChatKeys', () => {
  test('passes through when focus is list', () => {
    const { ctx } = makeCtx({ kind: 'list' })
    expect(handleChatKeys({ input: 'j', key: makeKey() }, ctx)).toBe('pass')
  })

  test('h returns to list focus', () => {
    const { ctx, store } = makeCtx(CHAT_FOCUS)
    expect(handleChatKeys({ input: 'h', key: makeKey() }, ctx)).toBe('handled')
    expect(store.get().focus.kind).toBe('list')
    expect(store.get().inputZone).toBe('list')
  })

  test('left arrow returns to list focus', () => {
    const { ctx, store } = makeCtx(CHAT_FOCUS)
    expect(handleChatKeys({ input: '', key: makeKey({ leftArrow: true }) }, ctx)).toBe('handled')
    expect(store.get().focus.kind).toBe('list')
  })

  test('j and J move cursor down by 1', () => {
    const a = makeCtx(CHAT_FOCUS)
    handleChatKeys({ input: 'j', key: makeKey() }, a.ctx)
    handleChatKeys({ input: 'J', key: makeKey() }, a.ctx)
    expect(a.movements).toEqual([1, 1])
  })

  test('k and K move cursor up by 1', () => {
    const a = makeCtx(CHAT_FOCUS)
    handleChatKeys({ input: 'k', key: makeKey() }, a.ctx)
    expect(a.movements).toEqual([-1])
  })

  test('u moves cursor up half a page', () => {
    const a = makeCtx(CHAT_FOCUS)
    handleChatKeys({ input: 'u', key: makeKey() }, a.ctx)
    expect(a.movements[0]).toBe(-10)
  })

  test('d moves cursor down half a page', () => {
    const a = makeCtx(CHAT_FOCUS)
    handleChatKeys({ input: 'd', key: makeKey() }, a.ctx)
    expect(a.movements[0]).toBe(10)
  })

  test('l with cursor at top tries to load older', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 0 })
    handleChatKeys({ input: 'l', key: makeKey() }, a.ctx)
    expect(a.loadOlderCalls).toBe(1)
    expect(a.bottomCalls).toBe(0)
  })

  test('l with cursor mid-list jumps to bottom', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 5 })
    handleChatKeys({ input: 'l', key: makeKey() }, a.ctx)
    expect(a.bottomCalls).toBe(1)
    expect(a.loadOlderCalls).toBe(0)
  })

  test('Enter at top tries to load older', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 0 })
    handleChatKeys({ input: '', key: makeKey({ return: true }) }, a.ctx)
    expect(a.loadOlderCalls).toBe(1)
  })

  test('Enter mid-list does nothing (passes through)', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 5 })
    expect(handleChatKeys({ input: '', key: makeKey({ return: true }) }, a.ctx)).toBe('pass')
    expect(a.loadOlderCalls).toBe(0)
    expect(a.bottomCalls).toBe(0)
  })

  test('Esc returns to list focus', () => {
    const { ctx, store } = makeCtx(CHAT_FOCUS)
    expect(handleChatKeys({ input: '', key: makeKey({ escape: true }) }, ctx)).toBe('handled')
    expect(store.get().focus.kind).toBe('list')
  })

  test('unhandled keys pass through', () => {
    const { ctx } = makeCtx(CHAT_FOCUS)
    expect(handleChatKeys({ input: 'x', key: makeKey() }, ctx)).toBe('pass')
  })
})
