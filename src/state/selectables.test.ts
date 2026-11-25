import { describe, expect, test } from 'bun:test'
import type { Chat, Team, Channel } from '../types'
import { accountRef } from '../account'
import { openAccount } from './accountStore'
import {
  buildSelectableList,
  CHAT_SECTION_CAP,
  collapseKeyFor,
  collapsedInSidebar,
  isSelectable,
  headerIndexForKey,
  parentCollapseKey,
  chatLabel,
  clampCursor,
  cursorAt,
  firstSelectableIndex,
  itemMatchesFilter,
  nextSelectableIndex,
  NEW_CHAT_ROW,
  resolveCursor,
  selectableKey,
  shortName,
  unifiedListInput,
  visibleList,
  type SelectableItem,
} from './selectables'
import { createAppStore, initialAppState, type AccountSlice, type Settings } from './store'

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
      teams: [team('t1', 'Contoso'), team('t2', 'Other')],
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

  test('default sort preserves the incoming (recency) chat order', () => {
    const state = {
      ...initialAppState(),
      chats: [chat('c1', { topic: 'Zoe' }), chat('c2', { topic: 'Amy' })],
    }
    const labels = buildSelectableList(state).map((i) => (i.kind === 'chat' ? i.label : null))
    expect(labels).toEqual(['Zoe', 'Amy'])
  })

  test('alphabetical sort orders chats by label', () => {
    const state = {
      ...initialAppState(),
      chats: [
        chat('c1', { topic: 'Zoe' }),
        chat('c2', { topic: 'amy' }),
        chat('c3', { topic: 'Bob' }),
      ],
      settings: { chatListSort: 'alphabetical' as const, chatListGroupByType: false },
    }
    const labels = buildSelectableList(state).map((i) => (i.kind === 'chat' ? i.label : null))
    expect(labels).toEqual(['amy', 'Bob', 'Zoe'])
  })

  test('group-by-type orders 1:1 → group → meeting, preserving order within a group', () => {
    const state = {
      ...initialAppState(),
      chats: [
        chat('m1', { topic: 'Standup', chatType: 'meeting' }),
        chat('g1', { topic: 'Eng', chatType: 'group' }),
        chat('d1', { topic: 'Ada', chatType: 'oneOnOne' }),
        chat('g2', { topic: 'Design', chatType: 'group' }),
      ],
      settings: { chatListSort: 'recent' as const, chatListGroupByType: true },
    }
    const labels = buildSelectableList(state)
      .filter((i) => i.kind === 'chat')
      .map((i) => (i.kind === 'chat' ? i.label : null))
    // 1:1 first, then groups (Eng before Design — recency preserved), then meeting.
    expect(labels).toEqual(['Ada', 'Eng', 'Design', 'Standup'])
  })

  test('group-by-type with alphabetical sorts within each section', () => {
    const state = {
      ...initialAppState(),
      chats: [
        chat('g1', { topic: 'Zeta', chatType: 'group' }),
        chat('g2', { topic: 'Alpha', chatType: 'group' }),
        chat('d1', { topic: 'Bo', chatType: 'oneOnOne' }),
        chat('d2', { topic: 'Ann', chatType: 'oneOnOne' }),
      ],
      settings: { chatListSort: 'alphabetical' as const, chatListGroupByType: true },
    }
    const labels = buildSelectableList(state)
      .filter((i) => i.kind === 'chat')
      .map((i) => (i.kind === 'chat' ? i.label : null))
    expect(labels).toEqual(['Ann', 'Bo', 'Alpha', 'Zeta'])
  })

  test('caps each grouped chat section and appends a `more` row', () => {
    const many = (prefix: string, chatType: Chat['chatType'], n: number) =>
      Array.from({ length: n }, (_, i) =>
        chat(`${prefix}${i}`, { topic: `${prefix}${i}`, chatType }),
      )
    const state = {
      ...initialAppState(),
      chats: [...many('d', 'oneOnOne', 12), ...many('g', 'group', 11), ...many('m', 'meeting', 3)],
      settings: { chatListSort: 'recent' as const, chatListGroupByType: true },
    }
    const list = buildSelectableList(state)
    // Each cap is independent, and the under-cap section keeps every row.
    expect(list.filter((i) => i.kind === 'chat')).toHaveLength(CHAT_SECTION_CAP * 2 + 3)
    expect(list.filter((i) => i.kind === 'more')).toEqual([
      { kind: 'more', section: 'oneOnOne', hidden: 2 },
      { kind: 'more', section: 'group', hidden: 1 },
    ])
    // The `more` row sits at the end of its own section (after the header and
    // the capped rows), not after all chats.
    expect(list[CHAT_SECTION_CAP + 1]).toEqual({ kind: 'more', section: 'oneOnOne', hidden: 2 })
  })

  test('an expanded section shows every row and drops its `more` row', () => {
    const state = {
      ...initialAppState(),
      chats: Array.from({ length: 12 }, (_, i) => chat(`d${i}`, { topic: `d${i}` })),
      settings: { chatListSort: 'recent' as const, chatListGroupByType: true },
      expandedChatSections: { oneOnOne: true },
    }
    const list = buildSelectableList(state)
    expect(list.filter((i) => i.kind === 'chat')).toHaveLength(12)
    expect(list.some((i) => i.kind === 'more')).toBe(false)
  })

  test('chatListSectionCap=false lists every chat with no `more` row', () => {
    const state = {
      ...initialAppState(),
      chats: Array.from({ length: 12 }, (_, i) => chat(`d${i}`, { topic: `d${i}` })),
      settings: {
        chatListSort: 'recent' as const,
        chatListGroupByType: true,
        chatListSectionCap: false,
      },
    }
    const list = buildSelectableList(state)
    expect(list.filter((i) => i.kind === 'chat')).toHaveLength(12)
    expect(list.some((i) => i.kind === 'more')).toBe(false)
  })

  test('an active filter lifts the cap so hidden chats stay reachable', () => {
    const state = {
      ...initialAppState(),
      chats: Array.from({ length: 12 }, (_, i) => chat(`d${i}`, { topic: `d${i}` })),
      settings: { chatListSort: 'recent' as const, chatListGroupByType: true },
      filter: 'd11',
    }
    const list = buildSelectableList(state)
    expect(list.filter((i) => itemMatchesFilter(i, 'd11'))).toHaveLength(1)
  })

  test('a collapsed chat section keeps its header and hides its rows', () => {
    const state = {
      ...initialAppState(),
      chats: [
        chat('d1', { topic: 'Ada' }),
        chat('g1', { topic: 'Eng', chatType: 'group' }),
        chat('g2', { topic: 'Design', chatType: 'group' }),
      ],
      settings: {
        chatListSort: 'recent' as const,
        chatListGroupByType: true,
        chatListCollapsedSections: { group: true },
      },
    }
    const list = buildSelectableList(state)
    expect(list.map((i) => i.kind)).toEqual(['section', 'chat', 'section'])
    const collapsedHeader = list[2]!
    expect(collapsedHeader).toEqual({
      kind: 'section',
      section: 'group',
      label: 'Groups',
      collapsed: true,
      count: 2,
    })
    // Only the collapsed header is a cursor stop; the expanded one is skipped.
    expect(isSelectable(list[0]!)).toBe(false)
    expect(isSelectable(collapsedHeader)).toBe(true)
  })

  test('a collapsed team hides its channels but keeps a selectable header', () => {
    const state = {
      ...initialAppState(),
      teams: [team('t1', 'Contoso'), team('t2', 'Other')],
      channelsByTeam: {
        t1: [channel('ch-a', 'General')],
        t2: [channel('ch-c', 'Standup')],
      },
      settings: { chatListCollapsedSections: { 'team:t1': true } },
    }
    const list = buildSelectableList(state)
    expect(list.map((i) => i.kind)).toEqual(['team', 'team', 'channel'])
    expect(isSelectable(list[0]!)).toBe(true) // collapsed
    expect(isSelectable(list[1]!)).toBe(false) // expanded
  })

  test('grouped lists put a collapsible Teams header over the team list', () => {
    const state = {
      ...initialAppState(),
      chats: [chat('d1', { topic: 'Ada' })],
      teams: [team('t1', 'Contoso'), team('t2', 'Other')],
      channelsByTeam: { t1: [channel('ch-a', 'General')] },
      settings: { chatListGroupByType: true },
    }
    expect(buildSelectableList(state).map((i) => i.kind)).toEqual([
      'section',
      'chat',
      'section',
      'team',
      'channel',
      'team',
    ])
    const collapsed = buildSelectableList({
      ...state,
      settings: { chatListGroupByType: true, chatListCollapsedSections: { teams: true } },
    })
    expect(collapsed.map((i) => i.kind)).toEqual(['section', 'chat', 'section'])
    expect(collapsed[2]).toEqual({
      kind: 'section',
      section: 'teams',
      label: 'Teams',
      collapsed: true,
      count: 2,
    })
    // Ungrouped lists have no section headers at all.
    const ungrouped = buildSelectableList({ ...state, settings: {} })
    expect(ungrouped.some((i) => i.kind === 'section')).toBe(false)
  })

  test('a filter reaches children of a collapsed section', () => {
    const state = {
      ...initialAppState(),
      chats: [chat('d1', { topic: 'Ada' }), chat('g1', { topic: 'Eng', chatType: 'group' })],
      settings: {
        chatListSort: 'recent' as const,
        chatListGroupByType: true,
        chatListCollapsedSections: { group: true },
      },
      filter: 'eng',
    }
    const list = buildSelectableList(state)
    expect(list.filter((i) => itemMatchesFilter(i, 'eng'))).toHaveLength(1)
  })

  test('parentCollapseKey derives the section from the row itself', () => {
    const state = {
      ...initialAppState(),
      chats: [chat('d1', { topic: 'Ada' }), chat('g1', { topic: 'Eng', chatType: 'group' })],
      teams: [team('t1', 'Contoso')],
      channelsByTeam: { t1: [channel('ch-a', 'General')] },
      settings: { chatListSort: 'recent' as const, chatListGroupByType: true },
    }
    const list = buildSelectableList(state)
    // [section Direct, Ada, section Groups, Eng, section Teams, team Contoso, # General]
    expect(parentCollapseKey(list[1]!, true)).toBe('oneOnOne')
    expect(parentCollapseKey(list[3]!, true)).toBe('group')
    expect(parentCollapseKey(list[6]!, true)).toBe('team:t1') // channel → its team
    expect(parentCollapseKey(list[5]!, true)).toBe('teams') // team → Teams
    expect(parentCollapseKey(list[0]!, true)).toBeNull() // a top-level header has no parent
    expect(parentCollapseKey(list[4]!, true)).toBeNull()
    // Ungrouped lists render no section headers, so a chat or team has
    // nothing to collapse into; a channel still belongs to its team.
    expect(parentCollapseKey(list[1]!, false)).toBeNull()
    expect(parentCollapseKey(list[5]!, false)).toBeNull()
    expect(parentCollapseKey(list[6]!, false)).toBe('team:t1')
  })

  test('a filtered view resolves a channel to its own team, not a nearer header', () => {
    // Team A matches the filter by name; a channel under team B matches too.
    // Scanning backwards for the nearest header would blame team A.
    const state = {
      ...initialAppState(),
      teams: [team('ta', 'Alpha'), team('tb', 'Beta')],
      channelsByTeam: { ta: [channel('ca', 'Random')], tb: [channel('cb', 'Alpha talk')] },
      filter: 'alpha',
    }
    const visible = buildSelectableList(state).filter((i) => itemMatchesFilter(i, 'alpha'))
    // [team Alpha, # Alpha talk] — the matching channel's own team is absent.
    const channelRow = visible.find((i) => i.kind === 'channel')!
    expect(parentCollapseKey(channelRow, false)).toBe('team:tb')
    expect(headerIndexForKey(visible, 'team:tb')).toBeNull()
  })

  test('ungrouped lists are never capped', () => {
    const state = {
      ...initialAppState(),
      chats: Array.from({ length: 12 }, (_, i) => chat(`d${i}`, { topic: `d${i}` })),
      settings: { chatListSort: 'recent' as const, chatListGroupByType: false },
    }
    expect(buildSelectableList(state)).toHaveLength(12) // no headers when ungrouped
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
        { id: 'm2', userId: 'other', displayName: 'Nordmann, Ola Berg' },
      ],
    })
    expect(chatLabel(c, 'me', { compact: true })).toBe('Ola')
    expect(chatLabel(c, 'me')).toBe('Nordmann, Ola Berg')
  })

  test('compact mode shortens each member in groups', () => {
    const c = chat('c', {
      chatType: 'group',
      members: [
        { id: 'm1', userId: 'me', displayName: 'Me' },
        { id: 'm2', userId: 'a', displayName: 'Aas, Anna' },
        { id: 'm3', userId: 'b', displayName: 'Bjorn Hansen' },
        { id: 'm4', userId: 'c', displayName: 'Carlsen, Kari' },
      ],
    })
    expect(chatLabel(c, 'me', { compact: true })).toBe('Anna, Bjorn, +1')
  })

  test('compact mode does not change topic-driven labels', () => {
    expect(chatLabel(chat('c', { topic: 'Standup' }), undefined, { compact: true })).toBe('Standup')
  })

  test('resolves a real name from nameByUserId when the roster has none', () => {
    const c = chat('c', {
      chatType: 'oneOnOne',
      members: [
        { id: 'm1', userId: 'me', displayName: 'Me' },
        { id: 'm2', userId: 'other', displayName: null },
      ],
    })
    expect(chatLabel(c, 'me')).toBe('(unknown)')
    expect(chatLabel(c, 'me', { nameByUserId: { other: 'Per Hansen' } })).toBe('Per Hansen')
  })

  test('prefers the indexed name over an email-shaped roster displayName', () => {
    const c = chat('c', {
      chatType: 'oneOnOne',
      members: [
        { id: 'm1', userId: 'me', displayName: 'Me' },
        { id: 'm2', userId: 'other', displayName: 'per.hansen@example.com' },
      ],
    })
    // Without an index we still show the email rather than nothing.
    expect(chatLabel(c, 'me')).toBe('per.hansen@example.com')
    expect(chatLabel(c, 'me', { nameByUserId: { other: 'Hansen, Per E.' } })).toBe('Hansen, Per E.')
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
    const item = { kind: 'chat' as const, chat: chat('c'), label: 'Contoso Eng' }
    expect(itemMatchesFilter(item, 'conto')).toBe(true)
    expect(itemMatchesFilter(item, 'ENG')).toBe(true)
    expect(itemMatchesFilter(item, 'standup')).toBe(false)
  })

  test('matches team displayName', () => {
    const item = { kind: 'team' as const, collapsed: false, team: team('t', 'Contoso Eng') }
    expect(itemMatchesFilter(item, 'conto')).toBe(true)
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
    // After comma we have "Ola Berg"; drop the trailing "Saethre".
    expect(shortName('Nordmann, Ola Berg')).toBe('Ola')
    expect(shortName('Nordmann, Kari Anne')).toBe('Kari')
  })

  test('comma-form with single given name returns that name', () => {
    expect(shortName('Nordmann, Ola')).toBe('Ola')
  })

  test('natural form: drops only the rightmost token', () => {
    expect(shortName('Kari Nordmann')).toBe('Kari')
    expect(shortName('Ola Kristian Berg-Nordmann')).toBe('Ola Kristian')
    expect(shortName('Anna Bjørg Maria Berg')).toBe('Anna Bjørg Maria')
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
    expect(shortName('Berg, Gustav Meyer')).toBe('Gustav')
  })
})

describe('nextSelectableIndex', () => {
  // Synthetic lists - only kinds matter for navigation skipping.
  const c = (id: string): SelectableItem => ({
    kind: 'chat',
    chat: chat(id),
    label: id,
  })
  const t = (id: string): SelectableItem => ({ kind: 'team', collapsed: false, team: team(id, id) })
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

describe('cursor keys', () => {
  const list = (ids: string[]) =>
    buildSelectableList({ ...initialAppState(), chats: ids.map((id) => chat(id, { topic: id })) })

  test('the cursor follows its row when a refresh reorders the list', () => {
    const { cursor, cursorKey } = cursorAt(list(['a', 'b', 'c']), 1)
    expect(cursorKey).toBe('chat:b')
    // b moved to the top (new message): the cursor goes with it.
    expect(resolveCursor(list(['b', 'a', 'c']), 3, cursorKey, cursor)).toBe(0)
  })

  test('falls back to the stored index when the row went away', () => {
    const { cursor, cursorKey } = cursorAt(list(['a', 'b', 'c']), 2)
    expect(resolveCursor(list(['a', 'b']), 2, cursorKey, cursor)).toBe(1)
    expect(resolveCursor(list(['a', 'b', 'd']), 3, cursorKey, cursor)).toBe(2)
  })

  test('the synthetic new-chat row has its own key', () => {
    expect(cursorAt([], 0).cursorKey).toBe(NEW_CHAT_ROW)
    expect(resolveCursor([], 1, NEW_CHAT_ROW, 5)).toBe(0)
  })
})

describe('unified list (M2 F.2)', () => {
  type Data = Partial<AccountSlice>
  // Every alias in `data` opened in order, the first in front; `settings`
  // patched over the defaults with accounts = the aliases.
  function unified(data: Record<string, Data>, settings: Partial<Settings> = {}, filter = '') {
    const store = createAppStore()
    Object.keys(data).forEach((alias, i) => {
      openAccount(store, accountRef(alias), { foreground: i === 0 }).set(data[alias]!)
    })
    store.set((s) => ({
      settings: { ...s.settings, accounts: Object.keys(data), ...settings },
      filter,
    }))
    return unifiedListInput(store.get())
  }
  const list = (...args: Parameters<typeof unified>) => visibleList(unified(...args)!)
  const keys = (items: SelectableItem[]) => items.map(selectableKey)
  const id = (alias: string) => accountRef(alias).id
  // Same ids in every account, as the collision fixtures have.
  const shared = (topic: string): Data => ({
    chats: [chat('c1', { topic: `${topic} one` }), chat('c2', { topic: `${topic} two` })],
    teams: [team('t1', `${topic} team`)],
    channelsByTeam: { t1: [channel('g', `${topic} general`)] },
  })

  test('single mode is untouched: no unified input, no tags, same keys', () => {
    const store = createAppStore()
    openAccount(store, accountRef('alpha'), { foreground: true }).set(shared('a'))
    store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha', 'beta'] } }))
    // beta is configured but not open: still one account.
    expect(unifiedListInput(store.get())).toBeNull()
    const items = visibleList(store.get())
    expect(items.some((it) => 'accountId' in it || 'alias' in it)).toBe(false)
    expect(keys(items)).toEqual(['chat:c1', 'chat:c2', 'team:t1', 'channel:t1/g'])
  })

  test('two and three accounts with identical ids are distinct rows, in configured order', () => {
    const two = list({ alpha: shared('a'), beta: shared('b') })
    expect(keys(two)).toEqual([
      `account:${id('alpha')}`,
      `${id('alpha')}/chat:c1`,
      `${id('alpha')}/chat:c2`,
      `${id('alpha')}/team:t1`,
      `${id('alpha')}/channel:t1/g`,
      `account:${id('beta')}`,
      `${id('beta')}/chat:c1`,
      `${id('beta')}/chat:c2`,
      `${id('beta')}/team:t1`,
      `${id('beta')}/channel:t1/g`,
    ])
    const three = list(
      { gamma: shared('g'), alpha: shared('a'), beta: shared('b') },
      {
        accounts: ['alpha', 'beta', 'gamma'],
      },
    )
    expect(new Set(keys(three)).size).toBe(three.length)
    expect(three.filter((it) => it.kind === 'account').map((it) => it.alias)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
    const c1 = three.filter((it) => it.kind === 'chat' && it.chat.id === 'c1')
    expect(c1.map((it) => [it.alias, it.kind === 'chat' && it.label])).toEqual([
      ['alpha', 'a one'],
      ['beta', 'b one'],
      ['gamma', 'g one'],
    ])
  })

  test('the account header carries label, unread, mentions and conn', () => {
    const [header] = list({
      alpha: {
        ...shared('a'),
        conn: 'authError',
        unreadMentionCount: 2,
        unreadByChatId: {
          c1: { unreadCount: 3, mentionCount: 0 },
          c2: { unreadCount: 0, mentionCount: 0 },
        },
      },
      beta: shared('b'),
    })
    expect(header).toEqual({
      kind: 'account',
      accountId: id('alpha'),
      alias: 'alpha',
      label: 'alpha',
      collapsed: false,
      unread: 1,
      mentions: 2,
      conn: 'authError',
    })
  })

  test('a failed or empty account shows its header only, and the header is a cursor stop', () => {
    const items = list({ alpha: shared('a'), beta: { conn: 'offline' } })
    const beta = items.at(-1)!
    expect(beta).toMatchObject({ kind: 'account', alias: 'beta', conn: 'offline' })
    expect(isSelectable(beta)).toBe(true)
    expect(isSelectable(items[0]!)).toBe(true)
    expect(nextSelectableIndex(items, items.length - 2, +1)).toBe(items.length - 1)
  })

  test('filter keeps only the headers of accounts with a match; no match is an empty list', () => {
    const data = { alpha: shared('alpha'), beta: shared('beta'), gamma: shared('gamma') }
    expect(keys(list(data, {}, 'beta'))).toEqual([
      `account:${id('beta')}`,
      `${id('beta')}/chat:c1`,
      `${id('beta')}/chat:c2`,
      `${id('beta')}/team:t1`,
      `${id('beta')}/channel:t1/g`,
    ])
    // A hit in two accounts shows both; section and team headers drop as in
    // single mode (team t1 matches on its own name only).
    expect(keys(list(data, { chatListGroupByType: true }, 'two'))).toEqual([
      `account:${id('alpha')}`,
      `${id('alpha')}/chat:c2`,
      `account:${id('beta')}`,
      `${id('beta')}/chat:c2`,
      `account:${id('gamma')}`,
      `${id('gamma')}/chat:c2`,
    ])
    // The header never matches on its own label.
    expect(list({ alpha: shared('x'), beta: shared('y') }, {}, 'alpha')).toEqual([])
  })

  test('collapse keys are per account; legacy keys apply to every account', () => {
    const data = { alpha: shared('a'), beta: shared('b') }
    const channels = (items: SelectableItem[]) =>
      items.filter((it) => it.kind === 'channel').map((it) => it.alias)
    expect(channels(list(data, { chatListCollapsedSections: { 'alpha/team:t1': true } }))).toEqual([
      'beta',
    ])
    expect(channels(list(data, { chatListCollapsedSections: { 'team:t1': true } }))).toEqual([])
    // An explicit false under the prefixed key reopens what a legacy key
    // collapses, for that account only.
    expect(
      channels(
        list(data, { chatListCollapsedSections: { 'team:t1': true, 'beta/team:t1': false } }),
      ),
    ).toEqual(['beta'])
    // Grouped sections too.
    const grouped = list(data, {
      chatListGroupByType: true,
      chatListCollapsedSections: { 'beta/oneOnOne': true },
    })
    expect(grouped.filter((it) => it.kind === 'chat').map((it) => it.alias)).toEqual([
      'alpha',
      'alpha',
    ])
  })

  test("an alias with / or : cannot collide with another account's keys", () => {
    // Unencoded, `account:foo`'s Teams section and `foo/teams`'s header were
    // both `account:foo/teams`.
    const data = { 'account:foo': shared('a'), 'foo/teams': shared('b') }
    const items = list(data, { chatListGroupByType: true })
    const teamsSection = items.find((it) => it.kind === 'section' && it.section === 'teams')!
    const header = items.find((it) => it.kind === 'account' && it.alias === 'foo/teams')!
    const keys = [collapseKeyFor(teamsSection), collapseKeyFor(header)]
    expect(new Set(keys).size).toBe(2)
    const collapsed = list(data, {
      chatListGroupByType: true,
      chatListCollapsedSections: { [collapseKeyFor(teamsSection)!]: true },
    })
    expect(collapsed.find((it) => it.kind === 'account' && it.alias === 'foo/teams')).toMatchObject(
      { collapsed: false },
    )
    expect(collapsed.filter((it) => it.kind === 'channel').map((it) => it.alias)).toEqual([
      'foo/teams',
    ])
    expect(headerIndexForKey(collapsed, collapseKeyFor(header)!)).toBe(
      collapsed.findIndex((it) => it.kind === 'account' && it.alias === 'foo/teams'),
    )
  })

  test('a collapsed account shows its header only; a filter lifts it', () => {
    const data = { alpha: shared('a'), beta: shared('b') }
    const collapsed = list(data, { chatListCollapsedSections: { 'account:alpha': true } })
    expect(collapsed[0]).toMatchObject({ kind: 'account', alias: 'alpha', collapsed: true })
    expect(collapsed[1]).toMatchObject({ kind: 'account', alias: 'beta', collapsed: false })
    const filtered = list(data, { chatListCollapsedSections: { 'account:alpha': true } }, 'one')
    expect(filtered.map((it) => it.alias)).toEqual(['alpha', 'alpha', 'beta', 'beta'])
    expect(filtered[0]).toMatchObject({ kind: 'account', collapsed: false })
  })

  test('header and parent keys carry the alias; the chain ends at the account', () => {
    const items = list(
      {
        alpha: { ...shared('a'), chats: [chat('c1'), chat('m1', { chatType: 'meeting' })] },
        beta: {},
      },
      { chatListGroupByType: true, chatListSectionCap: false },
    )
    const find = (kind: SelectableItem['kind'], alias = 'alpha') =>
      items.find((it) => it.kind === kind && it.alias === alias)!
    expect(collapseKeyFor(find('account'))).toBe('account:alpha')
    expect(collapseKeyFor(find('section'))).toBe('alpha/oneOnOne')
    expect(collapseKeyFor(find('team'))).toBe('alpha/team:t1')
    expect(parentCollapseKey(find('channel'), true)).toBe('alpha/team:t1')
    expect(parentCollapseKey(find('team'), true)).toBe('alpha/teams')
    expect(parentCollapseKey(find('chat'), true)).toBe('alpha/oneOnOne')
    expect(parentCollapseKey(find('section'), true)).toBe('account:alpha')
    expect(parentCollapseKey(find('account'), true)).toBeNull()
    expect(headerIndexForKey(items, 'alpha/team:t1')).toBe(items.indexOf(find('team')))
    expect(headerIndexForKey(items, 'account:beta')).toBe(items.length - 1)
    // Ungrouped: a chat or team has no section, so its parent is the account.
    const flat = list({ alpha: shared('a'), beta: {} })
    const chatRow = flat.find((it) => it.kind === 'chat')!
    const teamRow = flat.find((it) => it.kind === 'team')!
    expect(parentCollapseKey(chatRow, false)).toBe('account:alpha')
    expect(parentCollapseKey(teamRow, false)).toBe('account:alpha')
  })

  test('… N more expands per account', () => {
    const many = (n: number): Data => ({
      chats: Array.from({ length: n }, (_, i) => chat(`c${i}`, { topic: `t${i}` })),
    })
    const more = (alphaExpanded: boolean) =>
      list(
        {
          alpha: {
            ...many(CHAT_SECTION_CAP + 2),
            expandedChatSections: { oneOnOne: alphaExpanded },
          },
          beta: many(CHAT_SECTION_CAP + 2),
        },
        { chatListGroupByType: true },
      )
        .filter((it) => it.kind === 'more')
        .map((it) => it.alias)
    expect(more(false)).toEqual(['alpha', 'beta'])
    expect(more(true)).toEqual(['beta'])
  })

  test('the cursor follows its row across a reorder inside its section, never into another', () => {
    const before = list({ alpha: shared('a'), beta: shared('b') })
    const at = before.findIndex((it) => it.alias === 'beta' && it.kind === 'chat')
    const { cursor, cursorKey } = cursorAt(before, at)
    expect(cursorKey).toBe(`${id('beta')}/chat:c1`)
    const reordered = (b: Data) => list({ alpha: shared('a'), beta: b })
    const b = shared('b')
    const after = reordered({ ...b, chats: [b.chats![1]!, b.chats![0]!] })
    const i = resolveCursor(after, after.length, cursorKey, cursor)
    expect(after[i]).toMatchObject({ kind: 'chat', alias: 'beta', chat: { id: 'c1' } })
    // The same id in alpha is never picked up.
    expect(i).not.toBe(after.findIndex((it) => it.alias === 'alpha' && it.kind === 'chat'))
  })
})

describe('collapsedInSidebar (presence fan-out)', () => {
  const state = (open: number, collapsed: Record<string, boolean>) => {
    const store = createAppStore()
    ;['alpha', 'beta'].slice(0, open).forEach((alias, i) => {
      openAccount(store, accountRef(alias), { foreground: i === 0 })
    })
    store.set((s) => ({ settings: { ...s.settings, chatListCollapsedSections: collapsed } }))
    return store.get()
  }
  test('a collapsed account fetches no member presence; the others and single mode do', () => {
    const s = state(2, { 'account:alpha': true })
    expect(collapsedInSidebar(s, accountRef('alpha'))).toBe(true)
    expect(collapsedInSidebar(s, accountRef('beta'))).toBe(false)
    // The persisted key from an earlier concurrent run is ignored with one account.
    expect(collapsedInSidebar(state(1, { 'account:alpha': true }), accountRef('alpha'))).toBe(false)
  })
})
