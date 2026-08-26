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
    // Each normal message is a sender-header line plus its body line.
    expect(messageRenderRowHeight({ kind: 'message', key: 'a', message: msg('a') })).toBe(2)
    const reactedRow: MessageRenderRow = {
      kind: 'message',
      key: 'b',
      message: { ...msg('b'), reactions: [{ reactionType: 'like' }] },
    }
    expect(messageRenderRowHeight(reactedRow)).toBe(2)
    expect(
      messageRenderRowHeight({
        kind: 'message',
        key: 'c',
        message: { ...msg('c'), _sendError: 'failed' },
      }),
    ).toBe(3)
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
    expect(messageRenderRowHeight({ kind: 'message', key: 'reply', message: replyMsg })).toBe(3)
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

    expect(messageRenderRowHeight(row)).toBe(3)
    expect(messageRenderRowHeight(row, { inlineImageRows: 4 })).toBe(7)
  })

  test('imageRowsForMessage resolver overrides the static image reservation', () => {
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
    // header(1) + body(1) + resolver(3). The static inlineImageRows is ignored
    // when a resolver is supplied (the loaded image's fitted height is dynamic).
    expect(messageRenderRowHeight(row, { inlineImageRows: 4, imageRowsForMessage: () => 3 })).toBe(
      5,
    )
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
      // header(1) + 3 wrapped body lines (12 chars / 5 cols).
    ).toBe(4)
  })

  test('keeps the bottom rows within the physical row budget', () => {
    const rows = buildMessageRows([
      msg('old', '2026-05-04T10:00:00Z'),
      msg('mid', '2026-05-05T10:00:00Z'),
      { ...msg('new', '2026-05-05T10:01:00Z'), reactions: [{ reactionType: 'like' }] },
    ])

    // Budget 5 = date row (1) + two height-2 messages.
    const visible = sliceMessageRowsToBudget(rows, { rowBudget: 5 })

    expect(visible.map(rowKey)).toEqual(['date-2026-05-05', 'mid', 'new'])
    expect(visible.reduce((sum, row) => sum + messageRenderRowHeight(row), 0)).toBe(5)
  })

  test('keeps the existing window while the focused message remains visible', () => {
    const rows = buildMessageRows([msg('a'), msg('b'), msg('c'), msg('d')])

    const visible = sliceMessageRowsToBudget(rows, {
      rowBudget: 4,
      focusedMessageId: 'b',
      focusActive: true,
      previousStart: 1,
    })

    expect(visible.map(rowKey)).toEqual(['a', 'b'])
  })

  test('scrolls up only when the focused message moves above the window', () => {
    const rows = buildMessageRows([msg('a'), msg('b'), msg('c'), msg('d')])

    const visible = sliceMessageRowsToBudget(rows, {
      rowBudget: 4,
      focusedMessageId: 'a',
      focusActive: true,
      previousStart: 2,
    })

    expect(visible.map(rowKey)).toEqual(['a', 'b'])
  })

  test('scrolls down only when the focused message moves below the window', () => {
    const rows = buildMessageRows([msg('a'), msg('b'), msg('c'), msg('d')])
    const start = chooseMessageRowsWindowStart(rows, {
      rowBudget: 4,
      focusedMessageId: 'd',
      focusActive: true,
      previousStart: 1,
    })
    const end = messageRowsWindowEnd(rows, start, {
      rowBudget: 4,
      focusedMessageId: 'd',
    })

    expect(rows.slice(start, end).map(rowKey)).toEqual(['c', 'd'])
  })
})

// Ink word-wraps (wrap-ansi, hard:true) rather than chopping every `columns`
// characters, so a line that breaks early ahead of a long URL costs a row the
// old ceil(len/width) math never counted. Inline images are anchored by
// summing these heights, so each missed row slid the picture out of its
// reserved block and over the text.
describe('wrapped-row heights match Ink wrapping', () => {
  const urlBody =
    'Hola boss. Talked to Finn a bit about some tasks to call for your expertise. What do you think ' +
    'about this UserStory? Would you take this on you? ' +
    'https://dev.azure.com/Norconsult-Group/NOCOS/_sprints/taskboard/NOCOS%20Team/NOCOS/NOCOS%20CD%201?w… ' +
    '(https://dev.azure.com/Norconsult-Group/NOCOS/_sprints/taskboard/NOCOS%20Team/NOCOS/NOCOS%20CD%201?workitem=16972) ' +
    'I will provide all the necessary support.'

  function height(content: string, columns: number): number {
    const message: ChatMessage = {
      id: 'x',
      createdDateTime: '2026-05-05T10:00:00Z',
      body: { contentType: 'text', content },
      from: { user: { id: 'u1', displayName: 'User' } },
    }
    // -1 for the sender header row the height includes.
    return (
      messageRenderRowHeight(
        { kind: 'message', key: 'x', message },
        { messageTextColumns: columns },
      ) - 1
    )
  }

  test('counts the row a long URL forces onto its own line', () => {
    // 402 chars over 110 columns is 4 by character division; the two long
    // URLs each force an early break, so Ink paints 5.
    expect(height(urlBody, 110)).toBe(5)
  })

  test('counts double-width glyphs as two columns', () => {
    // 40 emoji = 80 columns wide, so they wrap at 60 columns; counting them
    // as one column each would call it a single row.
    expect(height('😄'.repeat(40), 60)).toBe(2)
  })
})
