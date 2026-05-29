import { describe, expect, test } from 'bun:test'
import { messageFocusables, selectFocusedAttachment } from './messageFocusables'
import { initialAppState } from '../state/store'
import type { AppState } from '../state/store'
import type { ChatMessage } from '../types'

function msg(over: Record<string, unknown> = {}): ChatMessage {
  return {
    id: 'm1',
    createdDateTime: '2026-05-29T10:00:00Z',
    chatId: 'c1',
    from: { user: { id: 'u1', displayName: 'Alice' } },
    body: { contentType: 'text', content: 'hi' },
    ...over,
  } as unknown as ChatMessage
}

describe('messageFocusables', () => {
  test('a plain text message has only the message body focusable', () => {
    expect(messageFocusables(msg())).toEqual([{ kind: 'message' }])
  })

  test('undefined message yields a single message focusable', () => {
    expect(messageFocusables(undefined)).toEqual([{ kind: 'message' }])
  })

  test('orders message, then images, then links', () => {
    const m = msg({
      chatId: 'c1',
      body: {
        contentType: 'html',
        content: '<img itemid="img-1"><a href="https://example.com/">x</a>',
      },
    })
    const focusables = messageFocusables(m)
    expect(focusables.map((f) => f.kind)).toEqual(['message', 'image', 'link'])
  })
})

describe('selectFocusedAttachment', () => {
  function stateWithMessage(m: ChatMessage, attachmentIndex: number): AppState {
    const s = initialAppState()
    s.focus = { kind: 'chat', chatId: 'c1' }
    s.messagesByConvo = { 'chat:c1': [m] }
    s.messageCursorByConvo = { 'chat:c1': 0 }
    s.focusedAttachmentIndex = attachmentIndex
    return s
  }

  test('returns null when focus is on the message body (index 0)', () => {
    const m = msg({
      body: { contentType: 'html', content: '<a href="https://example.com/">x</a>' },
    })
    expect(selectFocusedAttachment(stateWithMessage(m, 0))).toBeNull()
  })

  test('returns the focused link', () => {
    const m = msg({
      body: { contentType: 'html', content: '<a href="https://example.com/">x</a>' },
    })
    const f = selectFocusedAttachment(stateWithMessage(m, 1))
    expect(f?.kind).toBe('link')
  })

  test('returns null when the index is out of range', () => {
    const m = msg()
    expect(selectFocusedAttachment(stateWithMessage(m, 5))).toBeNull()
  })

  test('returns null in list focus', () => {
    const s = initialAppState()
    s.focus = { kind: 'list' }
    s.focusedAttachmentIndex = 1
    expect(selectFocusedAttachment(s)).toBeNull()
  })
})
