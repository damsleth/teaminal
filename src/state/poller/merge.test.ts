import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../../types'
import { countNewMessages, mergeChronological, newestMessageId } from './merge'

function msg(id: string, ts: string, extra?: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    createdDateTime: ts,
    body: { contentType: 'text', content: id },
    ...extra,
  }
}

describe('mergeChronological', () => {
  test('returns the existing list when there is nothing incoming', () => {
    const a = [msg('a', '2026-01-01T00:00:00Z')]
    expect(mergeChronological(a, [])).toEqual(a)
  })

  test('returns the incoming list when there is nothing existing', () => {
    const b = [msg('b', '2026-01-01T00:00:00Z')]
    expect(mergeChronological([], b)).toEqual(b)
  })

  test('sorts merged output by createdDateTime ascending', () => {
    const existing = [msg('z', '2026-01-01T00:00:00Z'), msg('a', '2026-01-03T00:00:00Z')]
    const incoming = [msg('m', '2026-01-02T00:00:00Z')]
    const merged = mergeChronological(existing, incoming)
    expect(merged.map((m) => m.id)).toEqual(['z', 'm', 'a'])
  })

  test('incoming wins on id collision (server-confirmed replaces optimistic)', () => {
    const existing = [msg('m1', '2026-01-01T00:00:00Z', { _sending: true })]
    const incoming = [
      msg('m1', '2026-01-01T00:00:00Z', { body: { contentType: 'text', content: 'final' } }),
    ]
    const merged = mergeChronological(existing, incoming)
    expect(merged).toHaveLength(1)
    expect(merged[0]?._sending).toBeUndefined()
    expect(merged[0]?.body.content).toBe('final')
  })

  test('preserves optimistic _sending messages whose ids do not appear in incoming', () => {
    const existing = [
      msg('m1', '2026-01-01T00:00:00Z'),
      msg('temp-1', '2026-01-01T00:00:01Z', { _sending: true, _tempId: 'temp-1' }),
    ]
    const incoming = [msg('m1', '2026-01-01T00:00:00Z')]
    const merged = mergeChronological(existing, incoming)
    expect(merged.map((m) => m.id)).toEqual(['m1', 'temp-1'])
    expect(merged[1]?._sending).toBe(true)
  })

  test('preserves optimistic _sendError messages', () => {
    const existing = [msg('temp-1', '2026-01-01T00:00:00Z', { _sendError: 'boom' })]
    const merged = mergeChronological(existing, [])
    expect(merged).toEqual(existing)
  })

  test('handles unparseable createdDateTime by treating it as 0', () => {
    const existing = [msg('a', 'not-a-date')]
    const incoming = [msg('b', '2026-01-01T00:00:00Z')]
    const merged = mergeChronological(existing, incoming)
    // 'a' has parsedTime=0; 'b' has positive time — 'a' sorts first.
    expect(merged.map((m) => m.id)).toEqual(['a', 'b'])
  })
})

describe('countNewMessages', () => {
  test('returns the count of incoming ids not in existing', () => {
    const existing = [msg('a', 'x'), msg('b', 'x')]
    const incoming = [msg('a', 'x'), msg('c', 'x'), msg('d', 'x')]
    expect(countNewMessages(existing, incoming)).toBe(2)
  })

  test('returns zero when all incoming are already known', () => {
    const existing = [msg('a', 'x'), msg('b', 'x')]
    const incoming = [msg('a', 'x'), msg('b', 'x')]
    expect(countNewMessages(existing, incoming)).toBe(0)
  })

  test('returns the full incoming length when existing is empty', () => {
    expect(countNewMessages([], [msg('a', 'x'), msg('b', 'x')])).toBe(2)
  })
})

describe('newestMessageId', () => {
  test('returns the id of the last element', () => {
    const messages = [msg('a', 'x'), msg('b', 'x'), msg('c', 'x')]
    expect(newestMessageId(messages)).toBe('c')
  })

  test('returns undefined for an empty list', () => {
    expect(newestMessageId([])).toBeUndefined()
  })
})
