import { describe, expect, test } from 'bun:test'
import type { Chat, Team, Channel } from '../types'
import {
  buildSelectableList,
  chatLabel,
  clampCursor,
  firstSelectableIndex,
  itemMatchesFilter,
  nextSelectableIndex,
  shortName,
  type SelectableItem,
} from './selectables'
import { initialAppState } from './store'

const team = (id: string, displayName: string): Team => ({ id, displayName })
const channel = (id: string, displayName: string, isArchived = false): Channel => ({
  id,
  displayName,
  isArchived,
})
const chat = (id: string, overrides: Partial<Chat> = {}): Chat => ({
  id,
  chatType: 'oneOnOne',
  createdDateTime: '2026-01-01T00:00:00Z',
  ...overrides,
})

describe('buildSelectableList', () => {
  test('returns empty array when nothing is loaded', () => {
    expect(buildSelectableList(initialAppState())).toEqual([])
  })

  test('lists chats first, then teams with channels indented', () => {
    const state = {
      ...initialAppState(),
      chats: [chat('c1', { topic: 'Eng' }), chat('c2')],
      teams: [team('t1', 'Crayon'), team('t2', 'Other')],
      channelsByTeam: {
        t1: [channel('ch-a', 'General'), channel('ch-b', 'Random')],
        t2: [channel('ch-c', 'Standup')],
      },
    }
    const list = buildSelectableList(state)
    const kinds = list.map((i) => i.kind)
    expect(kinds).toEqual(['chat', 'chat', 'team', 'channel', 'channel', 'team', 'channel'])
  })

  test('skips archived channels', () => {
    const state = {
      ...initialAppState(),
      teams: [team('t1', 'X')],
      channelsByTeam: { t1: [channel('a', 'A'), channel('b', 'B', true)] },
    }
    const list = buildSelectableList(state)
    expect(list.filter((i) => i.kind === 'channel')).toHaveLength(1)
  })
})

describe('chatLabel', () => {
  test('uses the topic when set', () => {
    expect(chatLabel(chat('c', { topic: 'Standup' }))).toBe('Standup')
  })

  test('returns the other member name for a hydrated 1:1', () => {
    const c = chat('c', {
      chatType: 'oneOnOne',
      members: [
        { id: 'm1', userId: 'me', displayName: 'Me' },
        { id: 'm2', userId: 'other', displayName: 'Other' },
      ],
    })
    expect(chatLabel(c, 'me')).toBe('Other')
  })

  test('joins two member names for a small group', () => {
    const c = chat('c', {
      chatType: 'group',
      members: [
        { id: 'm1', userId: 'me', displayName: 'Me' },
        { id: 'm2', userId: 'a', displayName: 'Anna' },
        { id: 'm3', userId: 'b', displayName: 'Bjorn' },
      ],
    })
    expect(chatLabel(c, 'me')).toBe('Anna, Bjorn')
  })

  test('truncates large groups with +N suffix', () => {
    const c = chat('c', {
      chatType: 'group',
      members: [
        { id: 'm1', userId: 'me', displayName: 'Me' },
        { id: 'm2', userId: 'a', displayName: 'A' },
        { id: 'm3', userId: 'b', displayName: 'B' },
        { id: 'm4', userId: 'c', displayName: 'C' },
        { id: 'm5', userId: 'd', displayName: 'D' },
      ],
    })
    expect(chatLabel(c, 'me')).toBe('A, B, +2')
  })

  test('falls back to chat type when members are not hydrated', () => {
    expect(chatLabel(chat('c', { chatType: 'oneOnOne' }))).toBe('(1:1)')
    expect(chatLabel(chat('c', { chatType: 'group' }))).toBe('(group)')
    expect(chatLabel(chat('c', { chatType: 'meeting' }))).toBe('(chat)')
  })

  test('compact mode returns first name only for 1:1 chats', () => {
    const c = chat('c', {
      chatType: 'oneOnOne',
      members: [
        { id: 'm1', userId: 'me', displayName: 'Me' },
        { id: 'm2', userId: 'other', displayName: 'Nordling, Finn Saethre' },
      ],
    })
    expect(chatLabel(c, 'me', { compact: true })).toBe('Finn')
    expect(chatLabel(c, 'me')).toBe('Nordling, Finn Saethre')
  })

  test('compact mode shortens each member in groups', () => {
    const c = chat('c', {
      chatType: 'group',
      members: [
        { id: 'm1', userId: 'me', displayName: 'Me' },
        { id: 'm2', userId: 'a', displayName: 'Aas, Anna' },
        { id: 'm3', userId: 'b', displayName: 'Bjorn Hansen' },
        { id: 'm4', userId: 'c', displayName: 'Carlsen, Carl' },
      ],
    })
    expect(chatLabel(c, 'me', { compact: true })).toBe('Anna, Bjorn, +1')
  })

  test('compact mode does not change topic-driven labels', () => {
    expect(chatLabel(chat('c', { topic: 'Standup' }), undefined, { compact: true })).toBe('Standup')
  })
})

describe('clampCursor', () => {
  test('returns 0 for an empty list', () => {
    expect(clampCursor(5, 0)).toBe(0)
  })

  test('clamps below zero', () => {
    expect(clampCursor(-3, 5)).toBe(0)
  })

  test('clamps past the end', () => {
    expect(clampCursor(10, 5)).toBe(4)
  })

  test('passes through valid indices', () => {
    expect(clampCursor(2, 5)).toBe(2)
  })
})

describe('itemMatchesFilter', () => {
  test('returns true for an empty filter (no narrowing)', () => {
    expect(itemMatchesFilter({ kind: 'chat', chat: chat('c'), label: 'Anything' }, '')).toBe(true)
  })

  test('matches chat label case-insensitively', () => {
    const item = { kind: 'chat' as const, chat: chat('c'), label: 'Crayon Eng' }
    expect(itemMatchesFilter(item, 'cray')).toBe(true)
    expect(itemMatchesFilter(item, 'ENG')).toBe(true)
    expect(itemMatchesFilter(item, 'standup')).toBe(false)
  })

  test('matches team displayName', () => {
    const item = { kind: 'team' as const, team: team('t', 'Crayon Eng') }
    expect(itemMatchesFilter(item, 'cray')).toBe(true)
    expect(itemMatchesFilter(item, 'design')).toBe(false)
  })

  test('matches channel displayName', () => {
    const item = {
      kind: 'channel' as const,
      team: team('t', 'X'),
      channel: channel('c', 'General'),
      label: 'General',
    }
    expect(itemMatchesFilter(item, 'gen')).toBe(true)
    expect(itemMatchesFilter(item, 'random')).toBe(false)
  })
})

describe('shortName', () => {
  test('comma-form: drops surname before comma, then drops trailing token', () => {
    // After comma we have "Finn Saethre"; drop the trailing "Saethre".
    expect(shortName('Nordling, Finn Saethre')).toBe('Finn')
    expect(shortName('Damsleth, Carl Joakim')).toBe('Carl')
  })

  test('comma-form with single given name returns that name', () => {
    expect(shortName('Nordling, Finn')).toBe('Finn')
  })

  test('natural form: drops only the rightmost token', () => {
    expect(shortName('Carl Damsleth')).toBe('Carl')
    expect(shortName('Ole Kristian Mørch-Storstein')).toBe('Ole Kristian')
    expect(shortName('Anna Bjørg Maria Vatne')).toBe('Anna Bjørg Maria')
  })

  test('returns the whole name when single-word', () => {
    expect(shortName('Mononym')).toBe('Mononym')
    expect(shortName('Madonna')).toBe('Madonna')
  })

  test('handles missing or empty input', () => {
    expect(shortName(undefined)).toBe('?')
    expect(shortName(null)).toBe('?')
    expect(shortName('')).toBe('?')
    expect(shortName('   ')).toBe('?')
  })

  test('preserves diacritics', () => {
    expect(shortName('Mørch, Gustav Meyer')).toBe('Gustav')
  })
})

describe('nextSelectableIndex', () => {
  // Synthetic lists - only kinds matter for navigation skipping.
  const c = (id: string): SelectableItem => ({
    kind: 'chat',
    chat: chat(id),
    label: id,
  })
  const t = (id: string): SelectableItem => ({ kind: 'team', team: team(id, id) })
  const ch = (id: string): SelectableItem => ({
    kind: 'channel',
    team: team('T', 'T'),
    channel: channel(id, id),
    label: id,
  })

  test('jumps forward over a single team header', () => {
    const items = [c('a'), t('T'), ch('g'), t('T2'), ch('r')]
    expect(nextSelectableIndex(items, 0, +1)).toBe(2)
  })

  test('jumps backward over a single team header', () => {
    const items = [c('a'), t('T'), ch('g'), t('T2'), ch('r')]
    expect(nextSelectableIndex(items, 3, +1)).toBe(4)
    expect(nextSelectableIndex(items, 4, -1)).toBe(2)
  })

  test('stays put when no movable target exists in direction', () => {
    const items = [c('a'), t('T1'), t('T2')]
    expect(nextSelectableIndex(items, 0, +1)).toBe(0)
    expect(nextSelectableIndex(items, 0, -1)).toBe(0)
  })

  test('walks past consecutive team headers', () => {
    const items = [ch('g'), t('T1'), t('T2'), ch('h')]
    expect(nextSelectableIndex(items, 0, +1)).toBe(3)
  })

  test('firstSelectableIndex skips leading teams', () => {
    const items = [t('T1'), ch('g'), c('a')]
    expect(firstSelectableIndex(items)).toBe(1)
  })

  test('firstSelectableIndex returns 0 when first item is selectable', () => {
    const items = [c('a'), t('T1'), ch('g')]
    expect(firstSelectableIndex(items)).toBe(0)
  })
})
