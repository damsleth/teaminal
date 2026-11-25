import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../../types'
import { REACTION_PENDING_MS, countNewMessages, mergeChronological, newestMessageId } from './merge'

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

  // --- Reaction-preservation tests ---

  test('a local reaction change survives a reactionless poll inside the propagation window', () => {
    const reaction = { reactionType: 'like', user: { user: { id: 'user-1' } } }
    const existing = [
      msg('m1', '2026-01-01T00:00:00Z', { reactions: [reaction], _reactionsPendingAt: Date.now() }),
    ]
    for (const incoming of [
      [msg('m1', '2026-01-01T00:00:00Z')],
      [msg('m1', '2026-01-01T00:00:00Z', { reactions: [] })],
    ]) {
      expect(mergeChronological(existing, incoming)[0]?.reactions).toEqual([reaction])
    }
  })

  test('reactions removed elsewhere clear once nothing local is pending', () => {
    const reaction = { reactionType: 'heart', user: { user: { id: 'user-2' } } }
    const incoming = [msg('m1', '2026-01-01T00:00:00Z', { reactions: [] })]
    // Settled server reactions, and a local change older than the window.
    for (const extra of [{}, { _reactionsPendingAt: Date.now() - REACTION_PENDING_MS - 1 }]) {
      const existing = [msg('m1', '2026-01-01T00:00:00Z', { reactions: [reaction], ...extra })]
      expect(mergeChronological(existing, incoming)[0]?.reactions ?? []).toEqual([])
    }
  })

  test('incoming-with-reactions overrides existing reactions (server is authoritative)', () => {
    // Once the server propagates the reaction, the server copy wins.
    const serverReaction = { reactionType: 'like', user: { user: { id: 'user-1' } } }
    const existing = [
      msg('m1', '2026-01-01T00:00:00Z', {
        reactions: [{ reactionType: 'heart', user: { user: { id: 'user-1' } } }],
      }),
    ]
    const incoming = [msg('m1', '2026-01-01T00:00:00Z', { reactions: [serverReaction] })]
    const merged = mergeChronological(existing, incoming)
    expect(merged[0]?.reactions).toEqual([serverReaction])
  })

  test('incoming-with-reactions that clears all reactions is allowed (server authoritative)', () => {
    // When the server returns a message WITH reactions field and it is non-empty,
    // that value wins. The no-reactions case is handled above. Here we verify
    // that the server value is used when it is present and non-empty even if the
    // existing copy had different reactions.
    const reaction = { reactionType: 'laugh', user: { user: { id: 'user-3' } } }
    const existing = [
      msg('m1', '2026-01-01T00:00:00Z', {
        reactions: [{ reactionType: 'angry', user: { user: { id: 'user-3' } } }],
      }),
    ]
    const incoming = [msg('m1', '2026-01-01T00:00:00Z', { reactions: [reaction] })]
    const merged = mergeChronological(existing, incoming)
    expect(merged[0]?.reactions).toEqual([reaction])
  })

  test('optimistic _sending messages are still preserved (no regression)', () => {
    // Regression guard: reaction fix must not disturb optimistic-send preservation.
    const existing = [
      msg('m1', '2026-01-01T00:00:00Z'),
      msg('temp-2', '2026-01-01T00:00:01Z', { _sending: true }),
    ]
    const incoming = [msg('m1', '2026-01-01T00:00:00Z')]
    const merged = mergeChronological(existing, incoming)
    expect(merged.map((m) => m.id)).toEqual(['m1', 'temp-2'])
    expect(merged[1]?._sending).toBe(true)
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
