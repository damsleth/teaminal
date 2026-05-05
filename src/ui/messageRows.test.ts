import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../types'
import {
  buildMessageRows,
  messageRenderRowHeight,
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

describe('message row viewport budgeting', () => {
  test('counts reaction and send-error continuations as physical rows', () => {
    expect(messageRenderRowHeight({ kind: 'message', key: 'a', message: msg('a') })).toBe(1)
    const reactedRow: MessageRenderRow = {
      kind: 'message',
      key: 'b',
      message: { ...msg('b'), reactions: [{ reactionType: 'like' }] },
    }
    expect(messageRenderRowHeight(reactedRow, { reactionDisplayMode: 'off' })).toBe(1)
    expect(
      messageRenderRowHeight(reactedRow, {
        reactionDisplayMode: 'current',
        focusedMessageId: 'a',
      }),
    ).toBe(1)
    expect(
      messageRenderRowHeight(reactedRow, {
        reactionDisplayMode: 'current',
        focusedMessageId: 'b',
      }),
    ).toBe(2)
    expect(
      messageRenderRowHeight({
        kind: 'message',
        key: 'c',
        message: { ...msg('c'), _sendError: 'failed' },
      }),
    ).toBe(2)
  })

  test('keeps the bottom rows within the physical row budget', () => {
    const rows = buildMessageRows([
      msg('old', '2026-05-04T10:00:00Z'),
      msg('mid', '2026-05-05T10:00:00Z'),
      { ...msg('new', '2026-05-05T10:01:00Z'), reactions: [{ reactionType: 'like' }] },
    ])

    const visible = sliceMessageRowsToBudget(rows, { rowBudget: 3 })

    expect(visible.map(rowKey)).toEqual(['mid', 'new'])
    expect(visible.reduce((sum, row) => sum + messageRenderRowHeight(row), 0)).toBe(3)
  })

  test('anchors a focused message at the bottom of the row budget', () => {
    const rows = buildMessageRows([msg('a'), msg('b'), msg('c'), msg('d')])

    const visible = sliceMessageRowsToBudget(rows, {
      rowBudget: 2,
      focusedMessageId: 'b',
      focusActive: true,
    })

    expect(visible.map(rowKey)).toEqual(['a', 'b'])
  })

  test('fills below the focused message when the viewport reaches history top', () => {
    const rows = buildMessageRows([msg('a'), msg('b'), msg('c'), msg('d')])

    const visible = sliceMessageRowsToBudget(rows, {
      rowBudget: 4,
      focusedMessageId: 'a',
      focusActive: true,
    })

    expect(visible.map(rowKey)).toEqual(['date-2026-05-05', 'a', 'b', 'c'])
  })
})
