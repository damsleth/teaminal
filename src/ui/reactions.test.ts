import { describe, expect, test } from 'bun:test'
import { aggregateReactions, reactionGlyph, reactionsSummary } from './reactions'
import type { Reaction } from '../types'

const r = (
  reactionType: Reaction['reactionType'],
  displayName?: string,
  userName?: string,
): Reaction => ({
  reactionType,
  createdDateTime: '2026-01-01T00:00:00Z',
  user: userName ? { user: { id: userName, displayName: userName } } : undefined,
  displayName,
})

describe('aggregateReactions', () => {
  test('empty input returns empty list', () => {
    expect(aggregateReactions(undefined)).toEqual([])
    expect(aggregateReactions([])).toEqual([])
  })

  test('groups by reactionType with counts', () => {
    const out = aggregateReactions([
      r('like', undefined, 'A'),
      r('like', undefined, 'B'),
      r('heart', undefined, 'C'),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ reactionType: 'like', count: 2 })
    expect(out[1]).toMatchObject({ reactionType: 'heart', count: 1 })
  })

  test('preserves insertion order of first occurrence', () => {
    const out = aggregateReactions([r('heart'), r('like'), r('heart'), r('laugh')])
    expect(out.map((b) => b.reactionType)).toEqual(['heart', 'like', 'laugh'])
  })

  test('captures up to 3 user names per bucket', () => {
    const out = aggregateReactions([
      r('like', undefined, 'A'),
      r('like', undefined, 'B'),
      r('like', undefined, 'C'),
      r('like', undefined, 'D'),
    ])
    expect(out[0]?.users).toEqual(['A', 'B', 'C'])
  })

  test('preserves displayName for custom reactions (first occurrence wins)', () => {
    const out = aggregateReactions([r('custom', 'taco'), r('custom', 'pizza')])
    expect(out[0]?.displayName).toBe('taco')
  })
})

describe('reactionGlyph', () => {
  test('known reactions map to glyphs', () => {
    expect(reactionGlyph('like')).toMatch(/\ud83d\udc4d/)
    expect(reactionGlyph('heart')).toContain('\u2764')
  })

  test('unknown reactions surface as :type: shorthand', () => {
    expect(reactionGlyph('confused')).toBe(':confused:')
  })

  test('emoji-valued reactions render without colon shorthand', () => {
    expect(reactionGlyph('😆')).toBe('😆')
    expect(reactionGlyph('❤️')).toBe('❤️')
  })
})

describe('reactionsSummary', () => {
  test('null when no reactions', () => {
    expect(reactionsSummary(undefined)).toBeNull()
    expect(reactionsSummary([])).toBeNull()
  })

  test('joins compact type counts with pipes', () => {
    const s = reactionsSummary([r('like'), r('like'), r('heart')])
    expect(s).toMatch(/\ud83d\udc4d2/)
    expect(s).toMatch(/\u2764\ufe0f/)
    expect(s).not.toMatch(/\u2764\ufe0f1/)
    expect(s?.includes('|')).toBe(true)
  })

  test('omits colons and single counts for emoji-valued reactions', () => {
    expect(reactionsSummary([r('😆'), r('❤️')])).toBe('😆|❤️')
    expect(reactionsSummary([r('😆'), r('😆'), r('❤️')])).toBe('😆2|❤️')
  })
})
