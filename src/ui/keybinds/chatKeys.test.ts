import { describe, expect, test } from 'bun:test'
import type { Key } from 'ink'
import { handleChatKeys, type ChatKeysCtx } from './chatKeys'
import { createAppStore } from '../../state/store'
import type { Focus } from '../../state/store'
import type { ChatMessage } from '../../types'

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
  attachmentSets: number[]
  openedLinks: string[]
  bottomCalls: number
  loadOlderCalls: number
} {
  const store = createAppStore()
  const movements: number[] = []
  const attachmentSets: number[] = []
  const openedLinks: string[] = []
  let bottomCalls = 0
  let loadOlderCalls = 0
  const ctx: ChatKeysCtx = {
    store,
    focus,
    activeMessageCursor: 5,
    focusables: [{ kind: 'message' }],
    focusedAttachmentIndex: 0,
    moveMessageCursor: (d) => movements.push(d),
    jumpMessageBottom: () => {
      bottomCalls++
    },
    tryLoadOlder: () => {
      loadOlderCalls++
    },
    setAttachmentIndex: (i) => attachmentSets.push(i),
    openLink: (href) => openedLinks.push(href),
    ...opts,
  }
  return {
    ctx,
    store,
    movements,
    attachmentSets,
    openedLinks,
    get bottomCalls() {
      return bottomCalls
    },
    get loadOlderCalls() {
      return loadOlderCalls
    },
  }
}

const IMG_REF = {
  cacheKey: 'm1::img1',
  sourcePath: 'https://media.giphy.com/x.gif',
  isExternal: true,
  name: 'cat.gif',
  contentType: 'image/gif',
}
const LINK_REF = { href: 'https://example.com/', label: 'example', key: 'm1::link::0' }

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

  test('Esc opens the menu overlay (does not return to list)', () => {
    const { ctx, store } = makeCtx(CHAT_FOCUS)
    store.set({ focus: CHAT_FOCUS })
    expect(handleChatKeys({ input: '', key: makeKey({ escape: true }) }, ctx)).toBe('handled')
    expect(store.get().focus).toEqual(CHAT_FOCUS)
    expect(store.get().modal?.kind).toBe('menu')
    expect(store.get().inputZone).toBe('menu')
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

  const ownMsg = (over: Record<string, unknown> = {}) =>
    ({
      id: 'm1',
      createdDateTime: '2026-05-29T10:00:00Z',
      body: { contentType: 'text', content: 'hi there' },
      from: { user: { id: 'me-1', displayName: 'Me' } },
      ...over,
    }) as unknown as ChatMessage

  test('r opens the reaction picker for the focused chat message', () => {
    const { ctx, store } = makeCtx(CHAT_FOCUS, { focusedMessage: ownMsg(), myUserId: 'me-1' })
    expect(handleChatKeys({ input: 'r', key: makeKey() }, ctx)).toBe('handled')
    expect(store.get().modal).toEqual({
      kind: 'reaction-picker',
      chatId: 'c1',
      messageId: 'm1',
      current: null,
    })
    expect(store.get().inputZone).toBe('menu')
  })

  test("r reflects the user's existing reaction as current", () => {
    const msg = ownMsg({ reactions: [{ reactionType: 'heart', user: { user: { id: 'me-1' } } }] })
    const { ctx, store } = makeCtx(CHAT_FOCUS, { focusedMessage: msg, myUserId: 'me-1' })
    handleChatKeys({ input: 'r', key: makeKey() }, ctx)
    expect((store.get().modal as { current?: string }).current).toBe('heart')
  })

  test("e starts editing the user's own message", () => {
    const { ctx, store } = makeCtx(CHAT_FOCUS, { focusedMessage: ownMsg(), myUserId: 'me-1' })
    expect(handleChatKeys({ input: 'e', key: makeKey() }, ctx)).toBe('handled')
    expect(store.get().editingMessageId).toBe('m1')
    expect(store.get().inputZone).toBe('composer')
  })

  test("e passes through on someone else's message", () => {
    const msg = ownMsg({ from: { user: { id: 'them-1' } } })
    const { ctx, store } = makeCtx(CHAT_FOCUS, { focusedMessage: msg, myUserId: 'me-1' })
    expect(handleChatKeys({ input: 'e', key: makeKey() }, ctx)).toBe('pass')
    expect(store.get().editingMessageId).toBeNull()
  })

  test('x opens the delete confirmation for an own message', () => {
    const { ctx, store } = makeCtx(CHAT_FOCUS, { focusedMessage: ownMsg(), myUserId: 'me-1' })
    expect(handleChatKeys({ input: 'x', key: makeKey() }, ctx)).toBe('handled')
    const modal = store.get().modal as { kind: string; messageId: string; preview: string }
    expect(modal.kind).toBe('confirm-delete')
    expect(modal.messageId).toBe('m1')
    expect(modal.preview).toBe('hi there')
  })

  test("x passes through on someone else's message", () => {
    const msg = ownMsg({ from: { user: { id: 'them-1' } } })
    const { ctx } = makeCtx(CHAT_FOCUS, { focusedMessage: msg, myUserId: 'me-1' })
    expect(handleChatKeys({ input: 'x', key: makeKey() }, ctx)).toBe('pass')
  })

  test('write keys pass through in channel focus', () => {
    const { ctx } = makeCtx(
      { kind: 'channel', teamId: 't1', channelId: 'ch1' },
      { focusedMessage: ownMsg(), myUserId: 'me-1' },
    )
    expect(handleChatKeys({ input: 'r', key: makeKey() }, ctx)).toBe('pass')
    expect(handleChatKeys({ input: 'x', key: makeKey() }, ctx)).toBe('pass')
  })

  test('j steps into attachments before moving to the next message', () => {
    const a = makeCtx(CHAT_FOCUS, {
      focusables: [{ kind: 'message' }, { kind: 'image', ref: IMG_REF }],
      focusedAttachmentIndex: 0,
    })
    handleChatKeys({ input: 'j', key: makeKey() }, a.ctx)
    expect(a.attachmentSets).toEqual([1])
    expect(a.movements).toEqual([])
  })

  test('j at the last focusable rolls over to the next message', () => {
    const a = makeCtx(CHAT_FOCUS, {
      focusables: [{ kind: 'message' }, { kind: 'image', ref: IMG_REF }],
      focusedAttachmentIndex: 1,
    })
    handleChatKeys({ input: 'j', key: makeKey() }, a.ctx)
    expect(a.attachmentSets).toEqual([])
    expect(a.movements).toEqual([1])
  })

  test('k steps back through attachments before leaving the message', () => {
    const a = makeCtx(CHAT_FOCUS, {
      focusables: [{ kind: 'message' }, { kind: 'image', ref: IMG_REF }],
      focusedAttachmentIndex: 1,
    })
    handleChatKeys({ input: 'k', key: makeKey() }, a.ctx)
    expect(a.attachmentSets).toEqual([0])
    expect(a.movements).toEqual([])
  })

  test('Space on a focused image opens the image modal', () => {
    const { ctx, store } = makeCtx(CHAT_FOCUS, {
      focusables: [{ kind: 'message' }, { kind: 'image', ref: IMG_REF }],
      focusedAttachmentIndex: 1,
    })
    expect(handleChatKeys({ input: ' ', key: makeKey() }, ctx)).toBe('handled')
    expect(store.get().modal).toEqual({ kind: 'image', ref: IMG_REF })
    expect(store.get().inputZone).toBe('menu')
  })

  test('Space on the message body (index 0) passes through', () => {
    const { ctx } = makeCtx(CHAT_FOCUS, {
      focusables: [{ kind: 'message' }, { kind: 'link', ref: LINK_REF }],
      focusedAttachmentIndex: 0,
    })
    expect(handleChatKeys({ input: ' ', key: makeKey() }, ctx)).toBe('pass')
  })

  test('Space on a focused link is handled (opens externally) without a modal', () => {
    const a = makeCtx(CHAT_FOCUS, {
      focusables: [{ kind: 'message' }, { kind: 'link', ref: LINK_REF }],
      focusedAttachmentIndex: 1,
    })
    expect(handleChatKeys({ input: ' ', key: makeKey() }, a.ctx)).toBe('handled')
    expect(a.store.get().modal).toBeNull()
    expect(a.openedLinks).toEqual(['https://example.com/'])
  })

  test('Esc in thread opens the menu (does not return to parent channel)', () => {
    const focus: Focus = {
      kind: 'thread',
      teamId: 't1',
      channelId: 'ch1',
      rootId: 'r1',
    }
    const { ctx, store } = makeCtx(focus)
    store.set({ focus })
    handleChatKeys({ input: '', key: makeKey({ escape: true }) }, ctx)
    expect(store.get().focus).toEqual(focus)
    expect(store.get().modal?.kind).toBe('menu')
  })
})
