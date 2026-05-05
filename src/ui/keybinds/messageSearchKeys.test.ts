import { describe, expect, test } from 'bun:test'
import type { Key } from 'ink'
import { createAppStore } from '../../state/store'
import type { ChatMessage } from '../../types'
import { handleMessageSearchKeys } from './messageSearchKeys'

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

function msg(id: string, content: string): ChatMessage {
  return {
    id,
    createdDateTime: '2026-01-01T00:00:00Z',
    body: { contentType: 'text', content },
  }
}

describe('handleMessageSearchKeys', () => {
  test('n steps search hits case-insensitively', () => {
    const store = createAppStore()
    const messages = [msg('m1', 'deploy'), msg('m2', 'skip'), msg('m3', 'deploy')]

    for (const input of ['n', 'N']) {
      store.set({ messageCursorByConvo: {}, messageSearchFocusedId: 'm1' })
      expect(
        handleMessageSearchKeys(
          { input, key: makeKey() },
          {
            store,
            focus: { kind: 'chat', chatId: 'c1' },
            query: 'deploy',
            focusedHitId: 'm1',
            messages,
          },
        ),
      ).toBe('handled')
      expect(store.get().messageCursorByConvo['chat:c1']).toBe(2)
      expect(store.get().messageSearchFocusedId).toBe('m3')
    }
  })
})
