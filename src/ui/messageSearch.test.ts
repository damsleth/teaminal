import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../types'
import { newestHitIndex, searchMessages, stepHit } from './messageSearch'

function msg(id: string, content: string, sender = 'Carl'): ChatMessage {
  return {
    id,
    createdDateTime: '2026-01-01T00:00:00Z',
    body: { contentType: 'text', content },
    from: { user: { id: sender.toLowerCase(), displayName: sender } },
  }
}

const corpus: ChatMessage[] = [
  msg('m1', 'hello world'),
  msg('m2', 'plan the deploy', 'Mike'),
  msg('m3', 'lunch?'),
  msg('m4', 'when is the deploy', 'Mike'),
  msg('m5', 'sometime tomorrow'),
  msg('m6', '<p>html-only <b>deploy</b> note</p>'),
]
// Last message has html body; tweak it to actually be html so htmlToText runs.
corpus[5]!.body = { contentType: 'html', content: '<p>html-only <b>deploy</b> note</p>' }

describe('searchMessages', () => {
  test('empty query returns no hits', () => {
    expect(searchMessages(corpus, '')).toEqual([])
    expect(searchMessages(corpus, '   ')).toEqual([])
  })

  test('case-insensitive substring across body content', () => {
    const hits = searchMessages(corpus, 'deploy')
    expect(hits.map((h) => h.id)).toEqual(['m2', 'm4', 'm6'])
  })

  test('matches on sender display name', () => {
    const hits = searchMessages(corpus, 'mike')
    expect(hits.map((h) => h.id)).toEqual(['m2', 'm4'])
  })

  test('html body is searched as plain text (no tag matches)', () => {
    expect(searchMessages(corpus, 'html-only').length).toBe(1)
    expect(searchMessages(corpus, '<b>').length).toBe(0)
  })
})

describe('stepHit', () => {
  const hits = searchMessages(corpus, 'deploy') // m2 (i=1), m4 (i=3), m6 (i=5)

  test('no hits returns null', () => {
    expect(stepHit([], null, 1)).toBeNull()
  })

  test('null current goes to first/last depending on direction', () => {
    expect(stepHit(hits, null, 1)).toBe(1)
    expect(stepHit(hits, null, -1)).toBe(5)
  })

  test('forward stepping wraps', () => {
    expect(stepHit(hits, 1, 1)).toBe(3)
    expect(stepHit(hits, 3, 1)).toBe(5)
    expect(stepHit(hits, 5, 1)).toBe(1)
  })

  test('backward stepping wraps', () => {
    expect(stepHit(hits, 5, -1)).toBe(3)
    expect(stepHit(hits, 1, -1)).toBe(5)
  })

  test('current not in hits snaps to nearest in the requested direction', () => {
    expect(stepHit(hits, 2, 1)).toBe(3)
    expect(stepHit(hits, 4, -1)).toBe(3)
    expect(stepHit(hits, 0, -1)).toBe(5)
  })
})

describe('newestHitIndex', () => {
  test('null when no hits', () => {
    expect(newestHitIndex([])).toBeNull()
  })
  test('largest index', () => {
    const hits = searchMessages(corpus, 'deploy')
    expect(newestHitIndex(hits)).toBe(5)
  })
})
