import { describe, expect, test } from 'bun:test'
import { isRenderableMessage, readReceiptLineForMessage } from './MessagePane'
import type { ChatMessage } from '../types'

const base = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  createdDateTime: '2026-05-05T20:17:00Z',
  body: { contentType: 'text', content: '' },
  ...over,
})

describe('readReceiptLineForMessage', () => {
  test('counts non-self receipts for the matching message', () => {
    expect(
      readReceiptLineForMessage(
        {
          me: { userId: 'me', messageId: 'm1', seenAt: 0 },
          u1: { userId: 'u1', messageId: 'm1', seenAt: 0 },
          u2: { userId: 'u2', messageId: 'm2', seenAt: 0 },
        },
        'm1',
        'me',
      ),
    ).toBe('seen by 1')
  })

  test('pluralizes multiple matching receipts', () => {
    expect(
      readReceiptLineForMessage(
        {
          u1: { userId: 'u1', messageId: 'm1', seenAt: 0 },
          u2: { userId: 'u2', messageId: 'm1', seenAt: 0 },
        },
        'm1',
        'me',
      ),
    ).toBe('seen by 2')
  })

  test('returns null without matching receipts', () => {
    expect(readReceiptLineForMessage(undefined, 'm1', 'me')).toBeNull()
    expect(
      readReceiptLineForMessage({ u1: { userId: 'u1', messageId: 'm2', seenAt: 0 } }, 'm1', 'me'),
    ).toBeNull()
  })
})

describe('isRenderableMessage', () => {
  test('keeps normal text messages', () => {
    expect(
      isRenderableMessage(
        base({
          messageType: 'message',
          from: { user: { id: 'u', displayName: 'Carl' } },
          body: { contentType: 'text', content: 'hello' },
        }),
      ),
    ).toBe(true)
  })

  test('drops systemEventMessage without eventDetail', () => {
    expect(isRenderableMessage(base({ messageType: 'systemEventMessage' }))).toBe(false)
  })

  test('drops systemEventMessage with unknown subtype', () => {
    expect(
      isRenderableMessage(
        base({
          messageType: 'systemEventMessage',
          eventDetail: { '@odata.type': '#microsoft.graph.unknownEventMessageDetail' },
        }),
      ),
    ).toBe(false)
  })

  test('keeps systemEventMessage we can decode', () => {
    expect(
      isRenderableMessage(
        base({
          messageType: 'systemEventMessage',
          eventDetail: {
            '@odata.type': '#microsoft.graph.chatCreatedEventMessageDetail',
          },
        }),
      ),
    ).toBe(true)
  })

  test('drops empty rows that would render as "(system)" with no body', () => {
    expect(
      isRenderableMessage(base({ from: null, body: { contentType: 'text', content: '' } })),
    ).toBe(false)
    expect(
      isRenderableMessage(base({ from: null, body: { contentType: 'text', content: '   ' } })),
    ).toBe(false)
  })

  test('keeps tombstone deletes (rendered as "(deleted by ...)")', () => {
    expect(
      isRenderableMessage(
        base({
          deletedDateTime: '2026-05-05T20:17:00Z',
          from: null,
          body: { contentType: 'text', content: '' },
        }),
      ),
    ).toBe(true)
  })

  test('keeps app/bot messages with no user but a populated body', () => {
    expect(
      isRenderableMessage(
        base({
          from: { user: null, application: { id: 'a', displayName: 'BotA' } },
          body: { contentType: 'text', content: 'reminder' },
        }),
      ),
    ).toBe(true)
  })
})
