import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../types'
import { getQuotedReply, messagesForTimelineNavigation } from './renderableMessage'

function msg(id: string, createdDateTime = '2026-05-05T10:00:00Z'): ChatMessage {
  return {
    id,
    createdDateTime,
    body: { contentType: 'text', content: id },
    from: { user: { id: 'u1', displayName: 'User' } },
  }
}

function hidden(id: string, createdDateTime = '2026-05-05T10:00:00Z'): ChatMessage {
  return {
    id,
    createdDateTime,
    body: { contentType: 'text', content: '' },
  }
}

describe('messagesForTimelineNavigation', () => {
  test('drops hidden Graph rows so cursor motion cannot land on them', () => {
    const messages = [
      msg('previous-day-visible', '2026-05-04T23:59:00Z'),
      hidden('hidden-date-boundary-row', '2026-05-05T00:00:00Z'),
      msg('current-day-visible', '2026-05-05T08:00:00Z'),
    ]

    expect(messagesForTimelineNavigation(messages).map((m) => m.id)).toEqual([
      'previous-day-visible',
      'current-day-visible',
    ])
  })

  test('keeps image-only messages so attachment rows can render', () => {
    const messages: ChatMessage[] = [
      {
        id: 'image-only',
        chatId: 'chat-1',
        createdDateTime: '2026-05-05T10:00:00Z',
        body: { contentType: 'html', content: '<p><img itemid="img-1"></p>' },
        from: { user: { id: 'u1', displayName: 'User' } },
      },
      {
        id: 'attachment-only',
        chatId: 'chat-1',
        createdDateTime: '2026-05-05T10:01:00Z',
        body: { contentType: 'html', content: '' },
        from: { user: { id: 'u1', displayName: 'User' } },
        attachments: [
          {
            id: 'att-1',
            contentType: 'image/png',
            name: 'photo.png',
          },
        ],
      },
    ]

    expect(messagesForTimelineNavigation(messages).map((m) => m.id)).toEqual([
      'image-only',
      'attachment-only',
    ])
  })
})

describe('getQuotedReply', () => {
  function reply(opts: { sender: string; preview: string; replyText: string }): ChatMessage {
    return {
      id: 'reply',
      createdDateTime: '2026-05-05T11:00:00Z',
      body: {
        contentType: 'html',
        content: `<attachment id="att-ref"></attachment><p>${opts.replyText}</p>`,
      },
      from: { user: { id: 'me', displayName: 'Me' } },
      attachments: [
        {
          id: 'att-ref',
          contentType: 'messageReference',
          content: JSON.stringify({
            messageId: 'orig-1',
            messageSender: { user: { id: 'u1', displayName: opts.sender } },
            messagePreview: opts.preview,
            createdDateTime: '2026-05-05T10:00:00Z',
          }),
        },
      ],
    }
  }

  test('returns sender short name and preview text', () => {
    const m = reply({
      sender: 'Anna Olsen',
      preview: 'lunch at 12 sound good?',
      replyText: 'sure',
    })
    expect(getQuotedReply(m)).toEqual({
      senderName: 'Anna',
      preview: 'lunch at 12 sound good?',
    })
  })

  test('truncates long previews to 60 columns with ellipsis', () => {
    const long = 'x'.repeat(120)
    const m = reply({ sender: 'Anna', preview: long, replyText: 'ok' })
    const q = getQuotedReply(m)
    expect(q).not.toBeNull()
    expect(q!.preview.length).toBe(60)
    expect(q!.preview.endsWith('…')).toBe(true)
  })

  test('returns null when content JSON is malformed (does not throw)', () => {
    const m: ChatMessage = {
      id: 'reply',
      createdDateTime: '2026-05-05T11:00:00Z',
      body: { contentType: 'html', content: '<p>hi</p>' },
      attachments: [{ id: 'a1', contentType: 'messageReference', content: '{not-json' }],
    }
    expect(getQuotedReply(m)).toBeNull()
  })

  test('returns null for non-reply messages (no messageReference attachment)', () => {
    const m: ChatMessage = {
      id: 'plain',
      createdDateTime: '2026-05-05T11:00:00Z',
      body: { contentType: 'text', content: 'hello' },
      attachments: [{ id: 'f1', contentType: 'application/pdf', name: 'report.pdf' }],
    }
    expect(getQuotedReply(m)).toBeNull()
  })

  test('returns null when attachments slice is undefined', () => {
    const m: ChatMessage = {
      id: 'plain',
      createdDateTime: '2026-05-05T11:00:00Z',
      body: { contentType: 'text', content: 'hello' },
    }
    expect(getQuotedReply(m)).toBeNull()
  })

  test('strips HTML from preview text', () => {
    const m = reply({
      sender: 'Anna',
      preview: '<p>hi <b>bold</b> stuff</p>',
      replyText: 'thx',
    })
    expect(getQuotedReply(m)?.preview).toBe('hi bold stuff')
  })
})
