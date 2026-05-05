import { describe, expect, test } from 'bun:test'
import type { ChatMessage, Mention } from '../../types'
import { shouldNotifyMention } from './mentions'

const ME_ID = 'me-id'
const OTHER_ID = 'other-id'

function msg(opts: { id?: string; fromId?: string; mentions?: Mention[] }): ChatMessage {
  return {
    id: opts.id ?? 'm1',
    createdDateTime: '2026-01-01T00:00:00Z',
    body: { contentType: 'text', content: 'x' },
    from: opts.fromId ? { user: { id: opts.fromId, displayName: 'X' } } : undefined,
    mentions: opts.mentions,
  }
}

describe('shouldNotifyMention', () => {
  test('returns false when the message has no mentions', () => {
    expect(shouldNotifyMention(msg({ fromId: OTHER_ID }), ME_ID)).toBe(false)
  })

  test('returns false when mentions is empty', () => {
    expect(shouldNotifyMention(msg({ fromId: OTHER_ID, mentions: [] }), ME_ID)).toBe(false)
  })

  test('returns true when a mention matches my user id and sender is not me', () => {
    const mentions: Mention[] = [
      { id: 0, mentionText: '@Me', mentioned: { user: { id: ME_ID, displayName: 'Me' } } },
    ]
    expect(shouldNotifyMention(msg({ fromId: OTHER_ID, mentions }), ME_ID)).toBe(true)
  })

  test('returns false when the mention matches but the sender is me (own echo)', () => {
    const mentions: Mention[] = [
      { id: 0, mentionText: '@Me', mentioned: { user: { id: ME_ID, displayName: 'Me' } } },
    ]
    expect(shouldNotifyMention(msg({ fromId: ME_ID, mentions }), ME_ID)).toBe(false)
  })

  test('returns false when no mention matches my user id', () => {
    const mentions: Mention[] = [
      {
        id: 0,
        mentionText: '@Other',
        mentioned: { user: { id: 'someone-else', displayName: 'Other' } },
      },
    ]
    expect(shouldNotifyMention(msg({ fromId: OTHER_ID, mentions }), ME_ID)).toBe(false)
  })

  test('returns true if any mention matches even when others do not', () => {
    const mentions: Mention[] = [
      {
        id: 0,
        mentionText: '@Other',
        mentioned: { user: { id: 'someone-else', displayName: 'Other' } },
      },
      { id: 1, mentionText: '@Me', mentioned: { user: { id: ME_ID, displayName: 'Me' } } },
    ]
    expect(shouldNotifyMention(msg({ fromId: OTHER_ID, mentions }), ME_ID)).toBe(true)
  })

  test('does not match on display name alone (id-based only)', () => {
    const mentions: Mention[] = [
      // No `mentioned.user.id` at all — only a display name.
      { id: 0, mentionText: '@Me', mentioned: { user: { id: '', displayName: 'Me' } } },
    ]
    expect(shouldNotifyMention(msg({ fromId: OTHER_ID, mentions }), ME_ID)).toBe(false)
  })
})
