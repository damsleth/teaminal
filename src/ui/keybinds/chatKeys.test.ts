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

  test('k and K move cursor up by 1 when not at top', () => {
    const a = makeCtx(CHAT_FOCUS)
    handleChatKeys({ input: 'k', key: makeKey() }, a.ctx)
    handleChatKeys({ input: 'K', key: makeKey() }, a.ctx)
    expect(a.movements).toEqual([-1, -1])
    expect(a.loadOlderCalls).toBe(0)
  })

  test('k at top tries to load older', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 0 })
    handleChatKeys({ input: 'k', key: makeKey() }, a.ctx)
    expect(a.movements).toEqual([])
    expect(a.loadOlderCalls).toBe(1)
  })

  test('up arrow at top tries to load older', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 0 })
    handleChatKeys({ input: '', key: makeKey({ upArrow: true }) }, a.ctx)
    expect(a.movements).toEqual([])
    expect(a.loadOlderCalls).toBe(1)
  })

  test('u moves cursor up half a page when not reaching top', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 15 })
    handleChatKeys({ input: 'u', key: makeKey() }, a.ctx)
    expect(a.movements[0]).toBe(-10)
    expect(a.loadOlderCalls).toBe(0)
  })

  test('u tries to load older when half-page motion reaches top', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 10 })
    handleChatKeys({ input: 'u', key: makeKey() }, a.ctx)
    expect(a.movements).toEqual([-10])
    expect(a.loadOlderCalls).toBe(1)
  })

  test('d moves cursor down half a page', () => {
    const a = makeCtx(CHAT_FOCUS)
    handleChatKeys({ input: 'd', key: makeKey() }, a.ctx)
    expect(a.movements[0]).toBe(10)
  })

  test('l jumps to bottom even with cursor at top', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 0 })
    handleChatKeys({ input: 'l', key: makeKey() }, a.ctx)
    expect(a.loadOlderCalls).toBe(0)
    expect(a.bottomCalls).toBe(1)
  })

  test('l with cursor mid-list jumps to bottom', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 5 })
    handleChatKeys({ input: 'l', key: makeKey() }, a.ctx)
    expect(a.bottomCalls).toBe(1)
    expect(a.loadOlderCalls).toBe(0)
  })

  test('Enter at top passes through instead of loading older', () => {
    const a = makeCtx(CHAT_FOCUS, { activeMessageCursor: 0 })
    expect(handleChatKeys({ input: '', key: makeKey({ return: true }) }, a.ctx)).toBe('pass')
    expect(a.loadOlderCalls).toBe(0)
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

  test('t opens a thread when in channel focus and a message is focused', () => {
    const { ctx, store } = makeCtx({
      kind: 'channel',
      teamId: 't1',
      channelId: 'ch1',
    })
    ctx.focusedMessageId = 'msg-root-1'
    expect(handleChatKeys({ input: 't', key: makeKey() }, ctx)).toBe('handled')
    expect(store.get().focus).toEqual({
      kind: 'thread',
      teamId: 't1',
      channelId: 'ch1',
      rootId: 'msg-root-1',
    })
  })

  test('t in channel focus without a focused message is a pass', () => {
    const { ctx } = makeCtx({ kind: 'channel', teamId: 't1', channelId: 'ch1' })
    expect(handleChatKeys({ input: 't', key: makeKey() }, ctx)).toBe('pass')
  })

  test('h in thread returns to parent channel, not to list', () => {
    const { ctx, store } = makeCtx({
      kind: 'thread',
      teamId: 't1',
      channelId: 'ch1',
      rootId: 'r1',
    })
    handleChatKeys({ input: 'h', key: makeKey() }, ctx)
    expect(store.get().focus).toEqual({
      kind: 'channel',
      teamId: 't1',
      channelId: 'ch1',
    })
  })

  test('Esc in thread returns to parent channel', () => {
    const { ctx, store } = makeCtx({
      kind: 'thread',
      teamId: 't1',
      channelId: 'ch1',
      rootId: 'r1',
    })
    handleChatKeys({ input: '', key: makeKey({ escape: true }) }, ctx)
    expect(store.get().focus.kind).toBe('channel')
  })
})
