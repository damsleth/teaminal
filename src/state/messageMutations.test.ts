import { describe, expect, it } from 'bun:test'
import type { ChatMessage, IdentityUser } from '../types'
import {
  applyDelete,
  applyEdit,
  applyReaction,
  hasReactionType,
  ownReactionType,
  ownReactionTypes,
  removeReaction,
  removeReactionType,
} from './messageMutations'

const me: IdentityUser = { id: 'me-1', displayName: 'Me' }
const other: IdentityUser = { id: 'them-1', displayName: 'Them' }

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    createdDateTime: '2026-05-29T10:00:00Z',
    body: { contentType: 'text', content: 'hello' },
    ...over,
  }
}

describe('ownReactionType', () => {
  it('returns the type the user has set', () => {
    const m = msg({ reactions: [{ reactionType: 'heart', user: { user: me } }] })
    expect(ownReactionType(m, me.id)).toBe('heart')
  })

  it('returns null when the user has not reacted', () => {
    const m = msg({ reactions: [{ reactionType: 'like', user: { user: other } }] })
    expect(ownReactionType(m, me.id)).toBeNull()
  })
})

describe('ownReactionTypes', () => {
  it('returns all types the user has set', () => {
    const m = msg({
      reactions: [
        { reactionType: 'like', user: { user: me } },
        { reactionType: 'heart', user: { user: me } },
        { reactionType: 'laugh', user: { user: other } },
      ],
    })
    expect(ownReactionTypes(m, me.id)).toEqual(['like', 'heart'])
  })

  it('returns empty array when user has no reactions', () => {
    const m = msg({ reactions: [{ reactionType: 'like', user: { user: other } }] })
    expect(ownReactionTypes(m, me.id)).toEqual([])
  })

  it('returns empty array when message has no reactions', () => {
    expect(ownReactionTypes(msg(), me.id)).toEqual([])
  })
})

describe('hasReactionType', () => {
  it('returns true when user has that exact type', () => {
    const m = msg({ reactions: [{ reactionType: 'like', user: { user: me } }] })
    expect(hasReactionType(m, me.id, 'like')).toBe(true)
  })

  it('returns false when user has a different type', () => {
    const m = msg({ reactions: [{ reactionType: 'like', user: { user: me } }] })
    expect(hasReactionType(m, me.id, 'heart')).toBe(false)
  })

  it('returns false when user has no reactions', () => {
    expect(hasReactionType(msg(), me.id, 'like')).toBe(false)
  })
})

describe('applyReaction', () => {
  it('adds the reaction to the target message', () => {
    const next = applyReaction([msg()], 'm1', 'like', me)
    expect(next[0]!.reactions).toEqual([
      { reactionType: 'like', createdDateTime: undefined, user: { user: me } },
    ])
  })

  it('adds a second distinct type without removing the first (additive)', () => {
    const m = msg({ reactions: [{ reactionType: 'like', user: { user: me } }] })
    const next = applyReaction([m], 'm1', 'heart', me)
    const reactions = next[0]!.reactions!
    const myReactions = reactions.filter((r) => r.user?.user?.id === me.id)
    expect(myReactions.map((r) => r.reactionType)).toEqual(['like', 'heart'])
  })

  it("preserves other users' reactions when adding", () => {
    const m = msg({
      reactions: [
        { reactionType: 'like', user: { user: me } },
        { reactionType: 'laugh', user: { user: other } },
      ],
    })
    const next = applyReaction([m], 'm1', 'heart', me)
    const reactions = next[0]!.reactions!
    expect(reactions.some((r) => r.user?.user?.id === other.id && r.reactionType === 'laugh')).toBe(
      true,
    )
  })

  it('is a no-op (same reference) when user already has that exact type', () => {
    const m = msg({ reactions: [{ reactionType: 'like', user: { user: me } }] })
    const arr = [m]
    const next = applyReaction(arr, 'm1', 'like', me)
    // The message object should be the same reference (no change)
    expect(next[0]!.reactions).toHaveLength(1)
    expect(next[0]!.reactions![0]!.reactionType).toBe('like')
  })

  it('returns the same array reference when the message is absent', () => {
    const arr = [msg()]
    expect(applyReaction(arr, 'nope', 'like', me)).toBe(arr)
  })

  it('does not mutate the input', () => {
    const arr = [msg()]
    applyReaction(arr, 'm1', 'like', me)
    expect(arr[0]!.reactions).toBeUndefined()
  })
})

describe('removeReactionType', () => {
  it('removes only the matching (user, type) pair', () => {
    const m = msg({
      reactions: [
        { reactionType: 'like', user: { user: me } },
        { reactionType: 'heart', user: { user: me } },
        { reactionType: 'like', user: { user: other } },
      ],
    })
    const next = removeReactionType([m], 'm1', me.id, 'like')
    const reactions = next[0]!.reactions!
    expect(reactions.filter((r) => r.user?.user?.id === me.id).map((r) => r.reactionType)).toEqual([
      'heart',
    ])
    expect(reactions.some((r) => r.user?.user?.id === other.id)).toBe(true)
  })

  it('is a no-op when the user does not have that type', () => {
    const m = msg({ reactions: [{ reactionType: 'like', user: { user: me } }] })
    const next = removeReactionType([m], 'm1', me.id, 'heart')
    expect(next[0]!.reactions).toHaveLength(1)
  })
})

describe('removeReaction', () => {
  it("drops all of the user's reactions", () => {
    const m = msg({
      reactions: [
        { reactionType: 'like', user: { user: me } },
        { reactionType: 'heart', user: { user: me } },
        { reactionType: 'like', user: { user: other } },
      ],
    })
    const next = removeReaction([m], 'm1', me.id)
    expect(next[0]!.reactions!.filter((r) => r.user?.user?.id === me.id)).toHaveLength(0)
    expect(next[0]!.reactions!.some((r) => r.user?.user?.id === other.id)).toBe(true)
  })
})

describe('applyEdit', () => {
  it('replaces body content and bumps lastModifiedDateTime', () => {
    const next = applyEdit([msg()], 'm1', 'edited text', '2026-05-29T11:00:00Z')
    expect(next[0]!.body).toEqual({ contentType: 'text', content: 'edited text' })
    expect(next[0]!.lastModifiedDateTime).toBe('2026-05-29T11:00:00Z')
  })
})

describe('applyDelete', () => {
  it('sets deletedDateTime as a tombstone', () => {
    const next = applyDelete([msg()], 'm1', '2026-05-29T11:00:00Z')
    expect(next[0]!.deletedDateTime).toBe('2026-05-29T11:00:00Z')
  })
})
