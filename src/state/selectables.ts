// Flat selectable list builder.
//
// Turns the chats + teams + channels in AppState into a single flat sequence
// the cursor can index into. Section headers ("Chats", "Teams") are NOT
// selectable - they're rendered separately in the ChatList component.
//
// Rebuilt on each render that needs it; cheap because the underlying lists
// are small (typically <100 chats, <30 teams * <20 channels).

import type { AppState, Settings } from './store'
import { resolveMemberName } from './nameIndex'
import type { Channel, Chat, Team } from '../types'

export type SelectableItem =
  | { kind: 'chat'; chat: Chat; label: string }
  // Chat-type header. Selectable only while collapsed — see isSelectable.
  | { kind: 'section'; section: ChatSection; label: string; collapsed: boolean; count: number }
  | { kind: 'team'; team: Team; collapsed: boolean }
  | { kind: 'channel'; team: Team; channel: Channel; label: string }
  // Overflow row shown when a grouped chat section exceeds CHAT_SECTION_CAP.
  // Selectable: Enter/l expands the section it belongs to.
  | { kind: 'more'; section: ChatSection; hidden: number }

type ChatItem = Extract<SelectableItem, { kind: 'chat' }>

export type SelectableInput = Pick<AppState, 'chats' | 'teams' | 'channelsByTeam' | 'me'> & {
  nameByUserId?: Record<string, string>
  // Ordering knobs. Optional so existing callers/tests get the default
  // 'recent', ungrouped order (identical to the previous behavior).
  // Partial so callers and tests can supply just the knobs they care about;
  // every field falls back to its default below.
  settings?: Partial<
    Pick<Settings, 'chatListSort' | 'chatListGroupByType' | 'chatListCollapsedSections'>
  >
  // A non-empty filter must be able to reach chats hidden behind a section
  // cap, so capping is skipped while filtering.
  filter?: string
  // Sections the user expanded past the cap via the `… N more` row.
  expandedChatSections?: Record<string, boolean>
}

// Collapsed-state key for a team. Chat sections key on their ChatSection name,
// so teams are prefixed to keep one flat map collision-free.
export function teamCollapseKey(teamId: string): string {
  return `team:${teamId}`
}

// The collapsed-state key a header row toggles, or null for a non-header.
export function collapseKeyFor(item: SelectableItem): string | null {
  if (item.kind === 'section') return item.section
  if (item.kind === 'team') return teamCollapseKey(item.team.id)
  return null
}

// Header rows are cursor stops only while collapsed. An expanded header's
// children are reachable on their own, so j/k glides past it the way team
// headers always have; a collapsed header must be focusable or its section
// could never be restored from the keyboard.
export function isSelectable(item: SelectableItem): boolean {
  if (item.kind === 'section' || item.kind === 'team') return item.collapsed
  return true
}

// The collapsed-state key of the section a row belongs to, or null when it has
// none (an ungrouped chat) or is itself a header — a focused collapsed header
// has nothing further to collapse into.
//
// Derived from the row itself, never by scanning backwards for the nearest
// header: under a filter the preceding header can belong to an unrelated
// section (team A's name matches, a channel of team B matches), and scanning
// would collapse the wrong one.
export function parentCollapseKey(item: SelectableItem, groupByType: boolean): string | null {
  if (item.kind === 'channel') return teamCollapseKey(item.team.id)
  // Ungrouped lists have no chat-type headers, so there is nothing to collapse.
  if (item.kind === 'chat') return groupByType ? chatSection(item.chat.chatType) : null
  if (item.kind === 'more') return item.section
  return null
}

// Index of the header row owning `key`, or null when that header isn't in
// `items` (filtered out). Callers use it only to move the cursor.
export function headerIndexForKey(items: SelectableItem[], key: string): number | null {
  for (let i = 0; i < items.length; i++) {
    if (collapseKeyFor(items[i]!) === key) return i
  }
  return null
}

// Section identity when grouping by chat type. Anything unrecognised lands
// in 'other', which sorts last. One source of truth for the sort rank, the
// rendered header label, and the per-section cap.
export type ChatSection = 'oneOnOne' | 'group' | 'meeting' | 'other'

const CHAT_SECTIONS: ChatSection[] = ['oneOnOne', 'group', 'meeting', 'other']

// Rows shown per section before the `… N more` row takes over. Without a cap
// a long Direct list pushes Meetings and the team/channel rows off the pane.
export const CHAT_SECTION_CAP = 10

export function chatSection(chatType: string): ChatSection {
  const s = chatType as ChatSection
  return CHAT_SECTIONS.includes(s) ? s : 'other'
}

export function chatSectionLabel(section: ChatSection): string {
  switch (section) {
    case 'oneOnOne':
      return 'Direct'
    case 'group':
      return 'Groups'
    case 'meeting':
      return 'Meetings'
    default:
      return 'Other'
  }
}

export function chatTypeRank(chatType: string): number {
  return CHAT_SECTIONS.indexOf(chatSection(chatType))
}

export function buildSelectableList(state: SelectableInput): SelectableItem[] {
  const sort = state.settings?.chatListSort ?? 'recent'
  const groupByType = state.settings?.chatListGroupByType ?? false
  // A filter has to reach rows hidden behind a section cap or a collapsed
  // header, so both are lifted (and headers dropped) while filtering.
  const filtering = !!state.filter
  const collapsed = filtering ? {} : (state.settings?.chatListCollapsedSections ?? {})

  let chatItems: ChatItem[] = state.chats.map((chat) => ({
    kind: 'chat',
    chat,
    label: chatLabel(chat, state.me?.id, { nameByUserId: state.nameByUserId }),
  }))
  chatItems = orderChats(chatItems, sort, groupByType)

  const items: SelectableItem[] =
    groupByType && !filtering
      ? sectionedChats(chatItems, collapsed, state.expandedChatSections ?? {})
      : [...chatItems]
  for (const team of state.teams) {
    const teamCollapsed = !!collapsed[teamCollapseKey(team.id)]
    items.push({ kind: 'team', team, collapsed: teamCollapsed })
    if (teamCollapsed) continue
    const channels = state.channelsByTeam[team.id] ?? []
    for (const channel of channels) {
      if (channel.isArchived) continue
      items.push({ kind: 'channel', team, channel, label: channel.displayName })
    }
  }
  return items
}

// Apply the chat-list sort, then (optionally) a stable group-by-type pass.
// 'recent' preserves the incoming server order; 'alphabetical' sorts by label.
// Array.prototype.sort is stable, so grouping keeps each section in the order
// the sort produced.
function orderChats(
  items: ChatItem[],
  sort: Settings['chatListSort'],
  groupByType: boolean,
): ChatItem[] {
  let out = items
  if (sort === 'alphabetical') {
    out = [...items].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    )
  }
  if (groupByType) {
    out = [...out].sort((a, b) => chatTypeRank(a.chat.chatType) - chatTypeRank(b.chat.chatType))
  }
  return out
}

// One header per chat type, followed by that section's rows: omitted entirely
// while collapsed, trimmed to CHAT_SECTION_CAP with a `… N more` row otherwise.
// Relies on orderChats having made each section contiguous.
function sectionedChats(
  items: ChatItem[],
  collapsed: Record<string, boolean>,
  expanded: Record<string, boolean>,
): SelectableItem[] {
  const out: SelectableItem[] = []
  let i = 0
  while (i < items.length) {
    const section = chatSection(items[i]!.chat.chatType)
    let end = i
    while (end < items.length && chatSection(items[end]!.chat.chatType) === section) end++
    const run = items.slice(i, end)
    const isCollapsed = !!collapsed[section]
    out.push({
      kind: 'section',
      section,
      label: chatSectionLabel(section),
      collapsed: isCollapsed,
      count: run.length,
    })
    if (isCollapsed) {
      i = end
      continue
    }
    if (expanded[section] || run.length <= CHAT_SECTION_CAP) {
      out.push(...run)
    } else {
      out.push(...run.slice(0, CHAT_SECTION_CAP))
      out.push({ kind: 'more', section, hidden: run.length - CHAT_SECTION_CAP })
    }
    i = end
  }
  return out
}

// Compute a friendly display label for a chat:
//   1. The user-set topic, if any.
//   2. Hydrated members - "Other Person" for 1:1, "A, B, +N" for groups.
//   3. A typed fallback so the row is at least navigable.
//
// `compact` runs each member's displayName through `shortName` (first
// name only). The sidebar uses compact; the message-pane header uses
// the full form so users can disambiguate "Carl Damsleth" from
// "Carl Joakim Damsleth" / "Carl Boberg" at a glance.
export function chatLabel(
  chat: Chat,
  myUserId?: string,
  opts?: { compact?: boolean; nameByUserId?: Record<string, string> },
): string {
  const compact = opts?.compact ?? false
  if (chat.topic) return chat.topic
  const others = (chat.members ?? []).filter((m) => m.userId !== myUserId)
  // Prefer a name resolved from message senders when the roster's
  // displayName is missing or just an email (see nameIndex.ts).
  const name = (i: number): string | null => resolveMemberName(others[i], opts?.nameByUserId)
  const fmt = (i: number): string => {
    const n = name(i)
    return compact ? shortName(n) : (n ?? '?')
  }
  if (others.length === 1) {
    const n = name(0)
    return compact ? shortName(n) : (n ?? '(unknown)')
  }
  if (others.length === 2) {
    return `${fmt(0)}, ${fmt(1)}`
  }
  if (others.length > 2) {
    return `${fmt(0)}, ${fmt(1)}, +${others.length - 2}`
  }
  // Fall back to chat type when we have nothing else (members not hydrated yet)
  return chat.chatType === 'oneOnOne' ? '(1:1)' : chat.chatType === 'group' ? '(group)' : '(chat)'
}

// Clamps the stored cursor index to the current list length. Returns 0 for
// an empty list. Stable so consumers can treat the result as definitive.
export function clampCursor(cursor: number, listLength: number): number {
  if (listLength === 0) return 0
  if (cursor < 0) return 0
  if (cursor >= listLength) return listLength - 1
  return cursor
}

// Expanded headers render as non-selectable rows; the cursor jumps over
// them. Walks `items` from `from + dir` in steps of `dir` looking for
// the next selectable item. Returns the original index when no movable
// target exists in that direction so the cursor stays put.
export function nextSelectableIndex(items: SelectableItem[], from: number, dir: 1 | -1): number {
  let i = from + dir
  while (i >= 0 && i < items.length) {
    if (isSelectable(items[i]!)) return i
    i += dir
  }
  return from
}

// First selectable index, scanning forward from 0. Returns 0 when no
// selectable item exists - clampCursor handles the empty case.
export function firstSelectableIndex(items: SelectableItem[]): number {
  for (let i = 0; i < items.length; i++) {
    if (isSelectable(items[i]!)) return i
  }
  return 0
}

// Short, message-row-friendly form of a display name. Strategy:
//   1. If formatted "Surname, Firstname [Middle...]" (common in corporate
//      AD), take the part after the comma. Otherwise use the name as-is.
//   2. Drop the rightmost whitespace-separated token (the surname in
//      natural order); preserves multi-given-name forms like
//      "Ole Kristian Mørch-Storstein" -> "Ole Kristian". Hyphenated
//      surnames have no whitespace inside so they count as one token.
// "Nordling, Finn Saethre" -> "Finn Saethre" -> "Finn";
// "Carl Damsleth" -> "Carl";
// "Ole Kristian Mørch-Storstein" -> "Ole Kristian".
// Used in MessagePane so message rows show first/given names instead of
// the full "Nordling, Finn Saethre" / "Damsleth, Carl Joakim" columns.
export function shortName(displayName: string | null | undefined): string {
  if (!displayName) return '?'
  const trimmed = displayName.trim()
  if (!trimmed) return '?'
  const commaIdx = trimmed.indexOf(',')
  // AD form "Surname, First Middle" — keep everything after the comma.
  // Natural form "First Middle Surname" — drop the rightmost token.
  const naturalOrder = commaIdx >= 0 ? trimmed.slice(commaIdx + 1).trim() : trimmed
  const tokens = naturalOrder.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return trimmed
  if (tokens.length === 1) return tokens[0]!
  return tokens.slice(0, -1).join(' ')
}

// Case-insensitive substring match against the displayed label (chat
// label, team displayName, or channel displayName). Used by both the
// chat-list filter input handler and the ChatList render so navigation
// and rendering stay aligned.
export function itemMatchesFilter(item: SelectableItem, filter: string): boolean {
  if (!filter) return true
  const needle = filter.toLowerCase()
  if (item.kind === 'chat') return item.label.toLowerCase().includes(needle)
  if (item.kind === 'team') return item.team.displayName.toLowerCase().includes(needle)
  // Caps and headers are both dropped while filtering, so neither a
  // `… N more` row nor a section header ever coexists with a filter.
  if (item.kind === 'more' || item.kind === 'section') return false
  return item.channel.displayName.toLowerCase().includes(needle)
}
