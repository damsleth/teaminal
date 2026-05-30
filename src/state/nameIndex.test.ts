import { describe, expect, test } from 'bun:test'
import type { Chat, ChatMessage } from '../types'
import {
  indexNamesFromChats,
  indexNamesFromMessages,
  looksLikeEmail,
  resolveMemberName,
} from './nameIndex'

const msg = (id: string, userId: string | undefined, displayName: string | null): ChatMessage =>
  ({
    id,
    createdDateTime: '2026-01-01T00:00:00Z',
    from: userId ? { user: { id: userId, displayName } } : null,
  }) as ChatMessage

describe('looksLikeEmail', () => {
  test('matches email-shaped strings, rejects names', () => {
    expect(looksLikeEmail('tarjei.ormestoyl@crayon.no')).toBe(true)
    expect(looksLikeEmail('Ormestøyl, Tarjei E.')).toBe(false)
    expect(looksLikeEmail('me@x')).toBe(false) // no dot in domain
    expect(looksLikeEmail(null)).toBe(false)
    expect(looksLikeEmail('')).toBe(false)
  })
})

describe('indexNamesFromMessages', () => {
  test('collects resolved sender names keyed by user id', () => {
    const out = indexNamesFromMessages({}, [
      msg('1', 'u-a', 'Anna Aas'),
      msg('2', 'u-b', 'Bjørn Hansen'),
    ])
    expect(out).toEqual({ 'u-a': 'Anna Aas', 'u-b': 'Bjørn Hansen' })
  })

  test('ignores empty and email-shaped sender names', () => {
    const out = indexNamesFromMessages({}, [
      msg('1', 'u-a', null),
      msg('2', 'u-b', '  '),
      msg('3', 'u-c', 'someone@contoso.com'),
    ])
    expect(out).toEqual({})
  })

  test('returns the same reference when nothing new is learned', () => {
    const existing = { 'u-a': 'Anna Aas' }
    const out = indexNamesFromMessages(existing, [msg('1', 'u-a', 'Anna Aas')])
    expect(out).toBe(existing)
  })

  test('updates a name when a fresher one arrives', () => {
    const existing = { 'u-a': 'Anna' }
    const out = indexNamesFromMessages(existing, [msg('1', 'u-a', 'Anna Aas')])
    expect(out).not.toBe(existing)
    expect(out['u-a']).toBe('Anna Aas')
  })
})

describe('indexNamesFromChats', () => {
  const chat = (overrides: Partial<Chat>): Chat => ({
    id: 'c',
    chatType: 'oneOnOne',
    createdDateTime: '2026-01-01T00:00:00Z',
    ...overrides,
  })

  test('harvests names from lastMessagePreview senders and usable member names', () => {
    const out = indexNamesFromChats({}, [
      chat({
        lastMessagePreview: {
          id: 'p1',
          createdDateTime: '2026-01-01T00:00:00Z',
          from: { user: { id: 'u-a', displayName: 'Anna Aas' } },
        },
        members: [
          { id: 'm1', userId: 'u-b', displayName: 'Bjørn Hansen' },
          { id: 'm2', userId: 'u-c', displayName: 'carl@crayon.no' }, // email — skipped
          { id: 'm3', userId: 'u-d', displayName: null }, // null — skipped
        ],
      }),
    ])
    expect(out).toEqual({ 'u-a': 'Anna Aas', 'u-b': 'Bjørn Hansen' })
  })
})

describe('resolveMemberName', () => {
  test('prefers a usable roster displayName', () => {
    expect(resolveMemberName({ id: 'm', userId: 'u', displayName: 'Anna Aas' })).toBe('Anna Aas')
  })

  test('falls back to the index when displayName is missing', () => {
    expect(resolveMemberName({ id: 'm', userId: 'u', displayName: null }, { u: 'Anna Aas' })).toBe(
      'Anna Aas',
    )
  })

  test('prefers the index over an email-shaped displayName', () => {
    expect(
      resolveMemberName({ id: 'm', userId: 'u', displayName: 'anna@x.com' }, { u: 'Anna Aas' }),
    ).toBe('Anna Aas')
  })

  test('shows the raw email when the index has nothing better', () => {
    expect(resolveMemberName({ id: 'm', userId: 'u', displayName: 'anna@x.com' })).toBe(
      'anna@x.com',
    )
  })

  test('returns null when there is nothing to show', () => {
    expect(resolveMemberName({ id: 'm', userId: 'u', displayName: null })).toBeNull()
    expect(resolveMemberName(undefined)).toBeNull()
  })
})
