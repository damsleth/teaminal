import { describe, expect, test } from 'bun:test'
import type { Chat } from '../../types'
import { mergeChatMembers } from './chatList'

function chat(id: string, members?: Chat['members']): Chat {
  return {
    id,
    chatType: 'oneOnOne',
    createdDateTime: '2026-01-01T00:00:00Z',
    members,
  }
}

describe('mergeChatMembers', () => {
  test('returns next as-is when prev is empty', () => {
    const next = [chat('a', [{ id: 'm1', displayName: 'X' }])]
    expect(mergeChatMembers([], next)).toBe(next)
  })

  test('carries forward members from prev when next has none', () => {
    const prev = [chat('a', [{ id: 'm1', displayName: 'X' }])]
    const next = [chat('a')]
    const merged = mergeChatMembers(prev, next)
    expect(merged[0]?.members).toEqual([{ id: 'm1', displayName: 'X' }])
  })

  test('prefers next.members when both have them', () => {
    const prev = [chat('a', [{ id: 'm1', displayName: 'OLD' }])]
    const next = [chat('a', [{ id: 'm1', displayName: 'NEW' }])]
    expect(mergeChatMembers(prev, next)[0]?.members).toEqual([{ id: 'm1', displayName: 'NEW' }])
  })

  test('passes through chats not in prev', () => {
    const prev = [chat('a', [{ id: 'm1', displayName: 'X' }])]
    const next = [chat('a'), chat('b')]
    const merged = mergeChatMembers(prev, next)
    expect(merged[0]?.members).toEqual([{ id: 'm1', displayName: 'X' }])
    expect(merged[1]?.members).toBeUndefined()
  })

  test('does not carry forward when prev had empty member list', () => {
    const prev = [chat('a', [])]
    const next = [chat('a')]
    expect(mergeChatMembers(prev, next)[0]?.members).toBeUndefined()
  })
})
