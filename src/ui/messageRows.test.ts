import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../types'
import {
  buildMessageRows,
  chooseMessageRowsWindowStart,
  messageRenderRowHeight,
  messageRowsWindowEnd,
  readMessagePageState,
  type MessageRenderRow,
  sliceMessageRowsToBudget,
} from './messageRows'

function msg(id: string, createdDateTime = '2026-05-05T10:00:00Z'): ChatMessage {
  return {
    id,
    createdDateTime,
    body: { contentType: 'text', content: id },
    from: { user: { id: 'u1', displayName: 'User' } },
  }
}

function rowKey(row: MessageRenderRow): string {
  if (row.kind === 'message' || row.kind === 'date') return row.key
  return 'load-more'
}

describe('readMessagePageState', () => {
  test('reports fullyLoaded so exhausted caches can hide the load-more row', () => {
    expect(
      readMessagePageState({
        messages: [msg('a')],
        loadingOlder: false,
        fullyLoaded: true,
      }),
    ).toEqual({ hasOlder: false, loading: false, fullyLoaded: true, error: undefined })
  })

  test('reports older history when a cache has a nextLink and is not fully loaded', () => {
    expect(
      readMessagePageState({
        messages: [msg('a')],
        nextLink: 'https://graph.microsoft.com/v1.0/chats/c1/messages?$skiptoken=older',
        loadingOlder: false,
        fullyLoaded: false,
      }),
    ).toEqual({ hasOlder: true, loading: false, fullyLoaded: false, error: undefined })
  })
})

describe('message row viewport budgeting', () => {
  test('counts send-error continuations as physical rows; inline reactions stay on one row', () => {
    expect(messageRenderRowHeight({ kind: 'message', key: 'a', message: msg('a') })).toBe(1)
    const reactedRow: MessageRenderRow = {
      kind: 'message',
      key: 'b',
      message: { ...msg('b'), reactions: [{ reactionType: 'like' }] },
    }
    expect(messageRenderRowHeight(reactedRow)).toBe(1)
    expect(
      messageRenderRowHeight({
        kind: 'message',
        key: 'c',
        message: { ...msg('c'), _sendError: 'failed' },
      }),
    ).toBe(2)
  })

  test('adds +1 row for chat-pane quoted replies', () => {
    const replyMsg = {
      ...msg('reply'),
      attachments: [
        {
          id: 'att-1',
          contentType: 'messageReference',
          content: JSON.stringify({
            messageId: 'orig',
            messageSender: { user: { id: 'u1', displayName: 'Anna' } },
            messagePreview: 'lunch at noon?',
          }),
        },
      ],
    }
    expect(messageRenderRowHeight({ kind: 'message', key: 'reply', message: replyMsg })).toBe(2)
  })

  test('counts inline image fallback rows', () => {
    const row: MessageRenderRow = {
      kind: 'message',
      key: 'm1',
      message: {
        id: 'm1',
        chatId: 'chat-1',
        createdDateTime: '2026-05-05T10:00:00Z',
        body: { contentType: 'html', content: '<p><img itemid="img-1"></p>' },
        from: { user: { id: 'u1', displayName: 'User' } },
      },
    }

    expect(messageRenderRowHeight(row)).toBe(2)
  })

  test('counts wrapped body text when estimating the viewport budget', () => {
    expect(
      messageRenderRowHeight(
        {
          kind: 'message',
          key: 'long',
          message: msg('abcdefghijkl'),
        },
        { messageTextColumns: 5 },
      ),
    ).toBe(3)
  })

  test('keeps the bottom rows within the physical row budget', () => {
    const rows = buildMessageRows([
      msg('old', '2026-05-04T10:00:00Z'),
      msg('mid', '2026-05-05T10:00:00Z'),
      { ...msg('new', '2026-05-05T10:01:00Z'), reactions: [{ reactionType: 'like' }] },
    ])

    const visible = sliceMessageRowsToBudget(rows, { rowBudget: 3 })

    expect(visible.map(rowKey)).toEqual(['date-2026-05-05', 'mid', 'new'])
    expect(visible.reduce((sum, row) => sum + messageRenderRowHeight(row), 0)).toBe(3)
  })

  test('keeps the existing window while the focused message remains visible', () => {
    const rows = buildMessageRows([msg('a'), msg('b'), msg('c'), msg('d')])

    const visible = sliceMessageRowsToBudget(rows, {
      rowBudget: 2,
      focusedMessageId: 'b',
      focusActive: true,
      previousStart: 1,
    })

    expect(visible.map(rowKey)).toEqual(['a', 'b'])
  })

  test('scrolls up only when the focused message moves above the window', () => {
    const rows = buildMessageRows([msg('a'), msg('b'), msg('c'), msg('d')])

    const visible = sliceMessageRowsToBudget(rows, {
      rowBudget: 2,
      focusedMessageId: 'a',
      focusActive: true,
      previousStart: 2,
    })

    expect(visible.map(rowKey)).toEqual(['a', 'b'])
  })

  test('scrolls down only when the focused message moves below the window', () => {
    const rows = buildMessageRows([msg('a'), msg('b'), msg('c'), msg('d')])
    const start = chooseMessageRowsWindowStart(rows, {
      rowBudget: 2,
      focusedMessageId: 'd',
      focusActive: true,
      previousStart: 1,
    })
    const end = messageRowsWindowEnd(rows, start, {
      rowBudget: 2,
      focusedMessageId: 'd',
    })

    expect(rows.slice(start, end).map(rowKey)).toEqual(['c', 'd'])
  })
})
