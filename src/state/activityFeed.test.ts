import { describe, expect, test } from 'bun:test'
import type { ActivityItem } from '../graph/teamsActivity'
import { countUnreadMentions, markActivityRead, mergeActivityItems } from './activityFeed'

function item(partial: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    kind: 'mention',
    createdAt: '2026-05-20T10:00:00Z',
    isRead: false,
    ...partial,
  }
}

describe('mergeActivityItems', () => {
  test('dedups by id, keeping incoming shape on conflict', () => {
    const current = [item({ id: 'a', preview: 'old' }), item({ id: 'b', preview: 'other' })]
    const incoming = [item({ id: 'a', preview: 'new' })]
    const merged = mergeActivityItems(current, incoming)
    expect(merged.map((m) => m.id)).toEqual(['a', 'b'])
    expect(merged[0]!.preview).toBe('new')
  })

  test('sorts by createdAt descending (newest first)', () => {
    const a = item({ id: 'a', createdAt: '2026-05-20T10:00:00Z' })
    const b = item({ id: 'b', createdAt: '2026-05-20T11:00:00Z' })
    const c = item({ id: 'c', createdAt: '2026-05-20T09:00:00Z' })
    const merged = mergeActivityItems([], [a, b, c])
    expect(merged.map((m) => m.id)).toEqual(['b', 'a', 'c'])
  })

  test('returns the same reference when incoming is empty', () => {
    const current = [item({ id: 'a' })]
    expect(mergeActivityItems(current, [])).toBe(current)
  })

  test('caps the feed at the implementation limit (200)', () => {
    const incoming: ActivityItem[] = []
    for (let i = 0; i < 250; i++) {
      incoming.push(item({ id: `i${i}`, createdAt: new Date(2026, 0, 1, 0, i).toISOString() }))
    }
    const merged = mergeActivityItems([], incoming)
    expect(merged.length).toBe(200)
  })
})

describe('countUnreadMentions', () => {
  test('counts only unread mention/reply items', () => {
    const items = [
      item({ id: 'a', kind: 'mention', isRead: false }),
      item({ id: 'b', kind: 'reply', isRead: false }),
      item({ id: 'c', kind: 'reaction', isRead: false }),
      item({ id: 'd', kind: 'mention', isRead: true }),
    ]
    expect(countUnreadMentions(items)).toBe(2)
  })
})

describe('markActivityRead', () => {
  test('flips isRead for the listed ids only', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
    const next = markActivityRead(items, ['b'])
    expect(next.map((i) => i.isRead)).toEqual([false, true, false])
  })

  test('"all" marks every unread row', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', isRead: true }), item({ id: 'c' })]
    const next = markActivityRead(items, 'all')
    expect(next.every((i) => i.isRead)).toBe(true)
  })

  test('returns the same array when nothing changed', () => {
    const items = [item({ id: 'a', isRead: true })]
    expect(markActivityRead(items, ['a'])).toBe(items)
  })
})
