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
  | { kind: 'team'; team: Team }
  | { kind: 'channel'; team: Team; channel: Channel; label: string }

type ChatItem = Extract<SelectableItem, { kind: 'chat' }>

export type SelectableInput = Pick<AppState, 'chats' | 'teams' | 'channelsByTeam' | 'me'> & {
  nameByUserId?: Record<string, string>
  // Ordering knobs. Optional so existing callers/tests get the default
  // 'recent', ungrouped order (identical to the previous behavior).
  settings?: Pick<Settings, 'chatListSort' | 'chatListGroupByType'>
}

// Section order when grouping by chat type. Anything unrecognised sorts last.
const CHAT_TYPE_RANK: Record<string, number> = { oneOnOne: 0, group: 1, meeting: 2 }

export function chatTypeRank(chatType: string): number {
  return CHAT_TYPE_RANK[chatType] ?? 3
}

export function buildSelectableList(state: SelectableInput): SelectableItem[] {
  const sort = state.settings?.chatListSort ?? 'recent'
  const groupByType = state.settings?.chatListGroupByType ?? false

  let chatItems: ChatItem[] = state.chats.map((chat) => ({
    kind: 'chat',
    chat,
    label: chatLabel(chat, state.me?.id, { nameByUserId: state.nameByUserId }),
  }))
  chatItems = orderChats(chatItems, sort, groupByType)

  const items: SelectableItem[] = [...chatItems]
  for (const team of state.teams) {
    items.push({ kind: 'team', team })
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

// Teams render as non-selectable section headers; the cursor jumps over
// them. Walks `items` from `from + dir` in steps of `dir` looking for
// the next item that is not a team. Returns the original index when no
// movable target exists in that direction so the cursor stays put.
export function nextSelectableIndex(items: SelectableItem[], from: number, dir: 1 | -1): number {
  let i = from + dir
  while (i >= 0 && i < items.length) {
    if (items[i]!.kind !== 'team') return i
    i += dir
  }
  return from
}

// First non-team index, scanning forward from 0. Returns 0 when no item
// (or only team items) exists - clampCursor handles the empty case.
export function firstSelectableIndex(items: SelectableItem[]): number {
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind !== 'team') return i
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
  return item.channel.displayName.toLowerCase().includes(needle)
}
