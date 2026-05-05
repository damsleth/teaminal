import { describe, expect, test } from 'bun:test'
import type { Chat, ChatMember } from '../types'
import { findExistingOneOnOne } from './derive'

function chat(opts: { id: string; type?: Chat['chatType']; members?: ChatMember[] }): Chat {
  return {
    id: opts.id,
    chatType: opts.type ?? 'oneOnOne',
    createdDateTime: '2026-01-01T00:00:00Z',
    members: opts.members,
  }
}

const SELF = 'self-id'
const OTHER = 'other-id'

describe('findExistingOneOnOne', () => {
  test('returns the matching 1:1 chat when both members are present', () => {
    const c = chat({
      id: 'c1',
      members: [
        { id: 'm1', userId: SELF, displayName: 'Me' },
        { id: 'm2', userId: OTHER, displayName: 'Other' },
      ],
    })
    expect(findExistingOneOnOne([c], OTHER, SELF)).toBe(c)
  })

  test('returns null when no chat contains the target user', () => {
    const c = chat({
      id: 'c1',
      members: [
        { id: 'm1', userId: SELF, displayName: 'Me' },
        { id: 'm2', userId: 'someone-else', displayName: 'X' },
      ],
    })
    expect(findExistingOneOnOne([c], OTHER, SELF)).toBeNull()
  })

  test('skips group chats even when both ids are members', () => {
    const c = chat({
      id: 'g1',
      type: 'group',
      members: [
        { id: 'm1', userId: SELF, displayName: 'Me' },
        { id: 'm2', userId: OTHER, displayName: 'Other' },
      ],
    })
    expect(findExistingOneOnOne([c], OTHER, SELF)).toBeNull()
  })

  test('returns null when the chat has no members hydrated', () => {
    const c = chat({ id: 'c1' })
    expect(findExistingOneOnOne([c], OTHER, SELF)).toBeNull()
  })

  test('returns the first match when multiple candidates exist', () => {
    const c1 = chat({
      id: 'c1',
      members: [
        { id: 'a', userId: SELF, displayName: 'Me' },
        { id: 'b', userId: OTHER, displayName: 'Other' },
      ],
    })
    const c2 = chat({
      id: 'c2',
      members: [
        { id: 'a', userId: SELF, displayName: 'Me' },
        { id: 'b', userId: OTHER, displayName: 'Other' },
      ],
    })
    expect(findExistingOneOnOne([c1, c2], OTHER, SELF)).toBe(c1)
  })
})
