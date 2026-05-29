import { describe, expect, it } from 'bun:test'
import type { ChatMessage, IdentityUser } from '../types'
import {
  applyDelete,
  applyEdit,
  applyReaction,
  ownReactionType,
  removeReaction,
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

describe('applyReaction', () => {
  it('adds the reaction to the target message', () => {
    const next = applyReaction([msg()], 'm1', 'like', me)
    expect(next[0]!.reactions).toEqual([{ reactionType: 'like', createdDateTime: undefined, user: { user: me } }])
  })

  it('replaces the user\'s existing reaction but keeps others', () => {
    const m = msg({
      reactions: [
        { reactionType: 'like', user: { user: me } },
        { reactionType: 'laugh', user: { user: other } },
      ],
    })
    const next = applyReaction([m], 'm1', 'heart', me)
    const reactions = next[0]!.reactions!
    expect(reactions.filter((r) => r.user?.user?.id === me.id)).toEqual([
      { reactionType: 'heart', createdDateTime: undefined, user: { user: me } },
    ])
    expect(reactions.some((r) => r.user?.user?.id === other.id && r.reactionType === 'laugh')).toBe(true)
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

describe('removeReaction', () => {
  it('drops only the user\'s reaction', () => {
    const m = msg({
      reactions: [
        { reactionType: 'like', user: { user: me } },
        { reactionType: 'like', user: { user: other } },
      ],
    })
    const next = removeReaction([m], 'm1', me.id)
    expect(next[0]!.reactions).toEqual([{ reactionType: 'like', user: { user: other } }])
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
