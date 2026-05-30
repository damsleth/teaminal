import { describe, expect, mock, test } from 'bun:test'
import type { Key } from 'ink'
import { handleResizeKeys, type ResizeKeysCtx } from './resizeKeys'
import { createAppStore } from '../../state/store'

// Silence config-persist fire-and-forget by mocking updateSettings at the
// module level. The in-memory store update is what the tests care about.
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

function makeCtx(
  chatListWidth = 30,
  composerHeight = 3,
): ResizeKeysCtx & { store: ReturnType<typeof createAppStore> } {
  const store = createAppStore()
  store.set({ inputZone: 'resize' })
  return {
    store,
    currentChatListWidth: chatListWidth,
    currentComposerHeight: composerHeight,
  }
}

describe('handleResizeKeys', () => {
  describe('leaving resize mode', () => {
    test('Esc returns to list zone', () => {
      const ctx = makeCtx()
      const result = handleResizeKeys({ input: '', key: makeKey({ escape: true }) }, ctx)
      expect(result).toBe('handled')
      expect(ctx.store.get().inputZone).toBe('list')
    })

    test('Enter returns to list zone', () => {
      const ctx = makeCtx()
      const result = handleResizeKeys({ input: '', key: makeKey({ return: true }) }, ctx)
      expect(result).toBe('handled')
      expect(ctx.store.get().inputZone).toBe('list')
    })
  })

  describe('reset to auto', () => {
    test('0 resets chatListWidth and composerHeight to null', () => {
      const ctx = makeCtx(40, 5)
      ctx.store.set({
        settings: { ...ctx.store.get().settings, chatListWidth: 40, composerHeight: 5 },
      })
      handleResizeKeys({ input: '0', key: makeKey() }, ctx)
      expect(ctx.store.get().settings.chatListWidth).toBeNull()
      expect(ctx.store.get().settings.composerHeight).toBeNull()
    })
  })

  describe('chat list width adjustments', () => {
    test('h shrinks chat list by 1', () => {
      const ctx = makeCtx(30, 3)
      handleResizeKeys({ input: 'h', key: makeKey() }, ctx)
      expect(ctx.store.get().settings.chatListWidth).toBe(29)
    })

    test('Left arrow shrinks chat list by 1', () => {
      const ctx = makeCtx(30, 3)
      handleResizeKeys({ input: '', key: makeKey({ leftArrow: true }) }, ctx)
      expect(ctx.store.get().settings.chatListWidth).toBe(29)
    })

    test('l widens chat list by 1', () => {
      const ctx = makeCtx(30, 3)
      handleResizeKeys({ input: 'l', key: makeKey() }, ctx)
      expect(ctx.store.get().settings.chatListWidth).toBe(31)
    })

    test('Right arrow widens chat list by 1', () => {
      const ctx = makeCtx(30, 3)
      handleResizeKeys({ input: '', key: makeKey({ rightArrow: true }) }, ctx)
      expect(ctx.store.get().settings.chatListWidth).toBe(31)
    })

    test('h cannot shrink below CHAT_LIST_WIDTH_MIN (12)', () => {
      const ctx = makeCtx(12, 3)
      handleResizeKeys({ input: 'h', key: makeKey() }, ctx)
      expect(ctx.store.get().settings.chatListWidth).toBe(12)
    })

    test('l cannot grow beyond CHAT_LIST_WIDTH_MAX (60)', () => {
      const ctx = makeCtx(60, 3)
      handleResizeKeys({ input: 'l', key: makeKey() }, ctx)
      expect(ctx.store.get().settings.chatListWidth).toBe(60)
    })
  })

  describe('composer height adjustments', () => {
    test('k shrinks composer by 1', () => {
      const ctx = makeCtx(30, 5)
      handleResizeKeys({ input: 'k', key: makeKey() }, ctx)
      expect(ctx.store.get().settings.composerHeight).toBe(4)
    })

    test('Up arrow shrinks composer by 1', () => {
      const ctx = makeCtx(30, 5)
      handleResizeKeys({ input: '', key: makeKey({ upArrow: true }) }, ctx)
      expect(ctx.store.get().settings.composerHeight).toBe(4)
    })

    test('j grows composer by 1', () => {
      const ctx = makeCtx(30, 5)
      handleResizeKeys({ input: 'j', key: makeKey() }, ctx)
      expect(ctx.store.get().settings.composerHeight).toBe(6)
    })

    test('Down arrow grows composer by 1', () => {
      const ctx = makeCtx(30, 5)
      handleResizeKeys({ input: '', key: makeKey({ downArrow: true }) }, ctx)
      expect(ctx.store.get().settings.composerHeight).toBe(6)
    })

    test('k cannot shrink below COMPOSER_HEIGHT_MIN (3)', () => {
      const ctx = makeCtx(30, 3)
      handleResizeKeys({ input: 'k', key: makeKey() }, ctx)
      expect(ctx.store.get().settings.composerHeight).toBe(3)
    })

    test('j cannot grow beyond COMPOSER_HEIGHT_MAX (10)', () => {
      const ctx = makeCtx(30, 10)
      handleResizeKeys({ input: 'j', key: makeKey() }, ctx)
      expect(ctx.store.get().settings.composerHeight).toBe(10)
    })
  })

  describe('unrecognized keys', () => {
    test('unknown key returns pass', () => {
      const ctx = makeCtx()
      const result = handleResizeKeys({ input: 'x', key: makeKey() }, ctx)
      expect(result).toBe('pass')
    })
  })
})
