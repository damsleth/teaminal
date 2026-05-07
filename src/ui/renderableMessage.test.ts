import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../types'
import { messagesForTimelineNavigation } from './renderableMessage'

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
})
