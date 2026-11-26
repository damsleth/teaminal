// Flat selectable list builder.
//
// Turns the chats + teams + channels in AppState into a single flat sequence
// the cursor can index into. Section headers ("Chats", "Teams") are NOT
// selectable - they're rendered separately in the ChatList component.
//
// Rebuilt on each render that needs it; cheap because the underlying lists
// are small (typically <100 chats, <30 teams * <20 channels).

import { accountRef, DEFAULT_PROFILE, type AccountId, type AccountRef } from '../account'
import {
  unreadTotals,
  type AccountSlice,
  type AppState,
  type ConnectionState,
  type Settings,
} from './store'
import { resolveMemberName } from './nameIndex'
import type { Channel, Chat, Team } from '../types'

// Unified sidebar (M2 F.2): the account a row belongs to, and that account's
// alias (the config identity collapse keys use). Absent in single mode, so
// single-mode lists and keys are unchanged.
type AccountTag = { accountId?: AccountId; alias?: string }
// A favorited chat or channel: the section it is listed under instead of its
// normal one (its account's Favorites, or the cross-account block).
type FavoriteSection = 'favorites' | 'crossFavorites'
type FavoriteTag = { favorite?: FavoriteSection }

export type SelectableItem =
  | ({ kind: 'chat'; chat: Chat; label: string } & AccountTag & FavoriteTag)
  // Chat-type header. Selectable only while collapsed — see isSelectable.
  | ({
      kind: 'section'
      section: ChatSection
      label: string
      collapsed: boolean
      count: number
    } & AccountTag)
  | ({ kind: 'team'; team: Team; collapsed: boolean } & AccountTag)
  | ({ kind: 'channel'; team: Team; channel: Channel; label: string } & AccountTag & FavoriteTag)
  // Overflow row shown when a grouped chat section exceeds CHAT_SECTION_CAP.
  // Selectable: Enter/l expands the section it belongs to.
  | ({ kind: 'more'; section: ChatSection; hidden: number } & AccountTag)
  // Unified sidebar: one header per open account, always a cursor stop.
  // `unread` (chats with unread activity) + `mentions` (unread activity-feed
  // mentions) = accountUnreadCount, what the E.5 header badge shows.
  | {
      kind: 'account'
      accountId: AccountId
      alias: string
      label: string
      collapsed: boolean
      unread: number
      mentions: number
      conn: ConnectionState
    }

type ChatItem = Extract<SelectableItem, { kind: 'chat' }>

export type SelectableInput = Pick<AppState, 'chats' | 'teams' | 'channelsByTeam' | 'me'> & {
  nameByUserId?: Record<string, string>
  // Ordering knobs. Optional so existing callers/tests get the default
  // 'recent', ungrouped order (identical to the previous behavior).
  // Partial so callers and tests can supply just the knobs they care about;
  // every field falls back to its default below.
  settings?: Partial<
    Pick<
      Settings,
      | 'chatListSort'
      | 'chatListGroupByType'
      | 'chatListSectionCap'
      | 'chatListCollapsedSections'
      | 'showFavorites'
      | 'favoritesByAccount'
      | 'crossAccountFavorites'
    >
  >
  // A non-empty filter must be able to reach chats hidden behind a section
  // cap, so capping is skipped while filtering.
  filter?: string
  // Sections the user expanded past the cap via the `… N more` row.
  expandedChatSections?: Record<string, boolean>
  // Ids (see favoriteId) listed under a Favorites section at the top instead
  // of their normal section. Single-mode callers get them from favoritesFor.
  favorites?: readonly string[]
  // Ids listed elsewhere (the unified sidebar's cross-account block): left
  // out of this list.
  elsewhere?: readonly string[]
}

// Collapsed-state key for a team. Chat sections key on their ChatSection name,
// so teams are prefixed to keep one flat map collision-free.
export function teamCollapseKey(teamId: string): string {
  return `team:${teamId}`
}

// The alias as it appears inside a collapse key: percent-encoded, so a `/` or
// `:` in an alias never acts as a separator (aliases `account:x` and `x/teams`
// must not both produce `account:x/teams`). Ordinary aliases are unchanged.
function aliasKey(alias: string): string {
  return encodeURIComponent(alias)
}

export function accountCollapseKey(alias: string): string {
  return `account:${aliasKey(alias)}`
}

// The prefix of an account's own section and team keys.
function accountKeyPrefix(alias: string): string {
  return `${aliasKey(alias)}/`
}

// A tagged row's section and team keys live under its account's alias, so
// collapsing team x in alpha leaves team x in beta open.
function scopedKey(item: AccountTag, key: string): string {
  return item.alias === undefined ? key : `${accountKeyPrefix(item.alias)}${key}`
}

// The collapsed-state key a header row toggles, or null for a non-header.
export function collapseKeyFor(item: SelectableItem): string | null {
  if (item.kind === 'account') return accountCollapseKey(item.alias)
  if (item.kind === 'section') return scopedKey(item, item.section)
  if (item.kind === 'team') return scopedKey(item, teamCollapseKey(item.team.id))
  return null
}

// Header rows are cursor stops only while collapsed. An expanded header's
// children are reachable on their own, so j/k glides past it the way team
// headers always have; a collapsed header must be focusable or its section
// could never be restored from the keyboard. An account header always is:
// it is the only way to reach a failed or empty account.
export function isSelectable(item: SelectableItem): boolean {
  if (item.kind === 'section' || item.kind === 'team') return item.collapsed
  return true
}

// The collapsed-state key of the section a row belongs to, or null when it has
// none (an ungrouped chat) or is itself a top-level header. A team header
// belongs to the Teams section when grouped: channel -> team -> Teams. In the
// unified sidebar the chain ends at the row's account header, so a row
// without a section belongs to its account.
//
// Derived from the row itself, never by scanning backwards for the nearest
// header: under a filter the preceding header can belong to an unrelated
// section (team A's name matches, a channel of team B matches), and scanning
// would collapse the wrong one.
export function parentCollapseKey(item: SelectableItem, groupByType: boolean): string | null {
  if (item.kind === 'account') return null
  const account = item.alias === undefined ? null : accountCollapseKey(item.alias)
  // The cross-account block sits above every account, so its key has none.
  if ((item.kind === 'chat' || item.kind === 'channel') && item.favorite)
    return item.favorite === 'crossFavorites' ? CROSS_FAVORITES : scopedKey(item, item.favorite)
  if (item.kind === 'channel') return scopedKey(item, teamCollapseKey(item.team.id))
  // Ungrouped lists have no chat-type headers, so there is nothing to collapse.
  if (item.kind === 'chat')
    return groupByType ? scopedKey(item, chatSection(item.chat.chatType)) : account
  if (item.kind === 'more') return scopedKey(item, item.section)
  if (item.kind === 'team') return groupByType ? scopedKey(item, 'teams') : account
  return account
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
// rendered header label, and the per-section cap. 'teams' is the header over
// the team list, 'favorites' the one over an account's favorited chats and
// channels and 'crossFavorites' the cross-account block's; none is a chat
// type, so they stay out of CHAT_SECTIONS.
export type ChatSection =
  'oneOnOne' | 'group' | 'meeting' | 'other' | 'teams' | 'favorites' | 'crossFavorites'

// Collapse key of the cross-account block: untagged, so no alias prefix, and
// not a name any other header key uses.
const CROSS_FAVORITES = 'crossFavorites'

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
    case 'teams':
      return 'Teams'
    case 'favorites':
    case 'crossFavorites':
      return 'Favorites'
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
  const cap = state.settings?.chatListSectionCap ?? true
  // A filter has to reach rows hidden behind a section cap or a collapsed
  // header, so both are lifted (and headers dropped) while filtering.
  const filtering = !!state.filter
  const collapsed = filtering ? {} : (state.settings?.chatListCollapsedSections ?? {})
  // Favorites move out of their sections. A filter lists them in place, as
  // it does every row of a collapsed or capped section.
  const elsewhere = new Set(filtering ? [] : (state.elsewhere ?? []))
  const favorites = new Set(
    filtering ? [] : (state.favorites ?? []).filter((id) => !elsewhere.has(id)),
  )
  const listed = (id: string) => !favorites.has(id) && !elsewhere.has(id)

  let chatItems: ChatItem[] = state.chats
    .filter((chat) => listed(chatFavoriteId(chat.id)))
    .map((chat) => chatItem(state, chat))
  chatItems = orderChats(chatItems, sort, groupByType)

  const items = favoritesSection(
    'favorites',
    favoriteRows(state, favorites, 'favorites'),
    collapsed,
  )
  if (groupByType && !filtering)
    items.push(...sectionedChats(chatItems, collapsed, state.expandedChatSections ?? {}, cap))
  else items.push(...chatItems)
  if (groupByType && !filtering && state.teams.length > 0) {
    const teamsCollapsed = !!collapsed.teams
    items.push({
      kind: 'section',
      section: 'teams',
      label: chatSectionLabel('teams'),
      collapsed: teamsCollapsed,
      count: state.teams.length,
    })
    if (teamsCollapsed) return items
  }
  for (const team of state.teams) {
    const teamCollapsed = !!collapsed[teamCollapseKey(team.id)]
    items.push({ kind: 'team', team, collapsed: teamCollapsed })
    if (teamCollapsed) continue
    const channels = state.channelsByTeam[team.id] ?? []
    for (const channel of channels) {
      if (channel.isArchived || !listed(channelFavoriteId(team.id, channel.id))) continue
      items.push({ kind: 'channel', team, channel, label: channel.displayName })
    }
  }
  return items
}

function chatItem(state: SelectableInput, chat: Chat): ChatItem {
  return {
    kind: 'chat',
    chat,
    label: chatLabel(chat, state.me?.id, { nameByUserId: state.nameByUserId }),
  }
}

// A favorite's stored id: the row key of its chat or channel row, so it
// stays the same whichever section lists the row.
function chatFavoriteId(chatId: string): string {
  return `chat:${chatId}`
}
function channelFavoriteId(teamId: string, channelId: string): string {
  return `channel:${teamId}/${channelId}`
}

// The id `f` stores for a row, or null for a row that can't be a favorite.
export function favoriteId(item: SelectableItem): string | null {
  if (item.kind === 'chat') return chatFavoriteId(item.chat.id)
  if (item.kind === 'channel') return channelFavoriteId(item.team.id, item.channel.id)
  return null
}

// The key an account's favorites are stored under: its alias, '' for the
// owa-piggy default profile (aliases are never empty).
export function favoritesKey(ref: AccountRef): string {
  return ref.profile === DEFAULT_PROFILE ? '' : ref.profile
}

// One account's favorites from settings: its own list and its cross-account
// list, or none while favorites are off.
function accountFavorites(
  settings: SelectableInput['settings'],
  key: string,
): { own: string[]; cross: string[] } {
  if (settings?.showFavorites === false) return { own: [], cross: [] }
  return {
    own: settings?.favoritesByAccount?.[key] ?? [],
    cross: settings?.crossAccountFavorites?.[key] ?? [],
  }
}

// The ids a single-account list shows under Favorites. With one account open
// the cross-account block would be a second "Favorites" right above the
// first, so both lists share the one section.
export function favoritesFor(
  settings: SelectableInput['settings'],
  ref: AccountRef | null | undefined,
): string[] {
  if (!ref) return []
  const { own, cross } = accountFavorites(settings, favoritesKey(ref))
  return [...cross, ...own]
}

// The favorited `ids` that exist, in list order: chats as sorted, then
// channels team by team. A favorite whose chat or channel is gone is skipped
// (and kept in config). No cap: every favorite shows.
function favoriteRows(
  state: SelectableInput,
  ids: ReadonlySet<string>,
  favorite: FavoriteSection,
): SelectableItem[] {
  if (ids.size === 0) return []
  const chats = orderChats(
    state.chats.filter((chat) => ids.has(chatFavoriteId(chat.id))).map((c) => chatItem(state, c)),
    state.settings?.chatListSort ?? 'recent',
    false,
  )
  const out: SelectableItem[] = chats.map((it) => ({ ...it, favorite }))
  for (const team of state.teams) {
    for (const channel of state.channelsByTeam[team.id] ?? []) {
      if (channel.isArchived || !ids.has(channelFavoriteId(team.id, channel.id))) continue
      // Without its team header above it, the row names the team.
      const label = `${team.displayName} › ${channel.displayName}`
      out.push({ kind: 'channel', team, channel, label, favorite })
    }
  }
  return out
}

// A Favorites header and its rows; nothing when there are no rows.
function favoritesSection(
  section: FavoriteSection,
  rows: SelectableItem[],
  collapsed: Record<string, boolean>,
): SelectableItem[] {
  if (rows.length === 0) return []
  const isCollapsed = !!collapsed[section]
  const header: SelectableItem = {
    kind: 'section',
    section,
    label: chatSectionLabel(section),
    collapsed: isCollapsed,
    count: rows.length,
  }
  return isCollapsed ? [header] : [header, ...rows]
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
// while collapsed, trimmed to CHAT_SECTION_CAP with a `… N more` row otherwise
// (unless the cap is off).
// Relies on orderChats having made each section contiguous.
function sectionedChats(
  items: ChatItem[],
  collapsed: Record<string, boolean>,
  expanded: Record<string, boolean>,
  cap: boolean,
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
    if (!cap || expanded[section] || run.length <= CHAT_SECTION_CAP) {
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
// the full form so users can disambiguate "Kari Nordmann" from
// "Kari Anne Nordmann" / "Kari Berg" at a glance.
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

// Stable identity of a list row, so the cursor stays on the same chat when a
// poll reorders the list. The synthetic "new chat" row (shown after a filter
// that matches nothing) sits at index visible.length and has key NEW_CHAT_ROW.
// Tagged rows are prefixed with their AccountId, so the same chat id in two
// accounts is two rows.
export const NEW_CHAT_ROW = 'new-chat'
export function accountRowKey(id: AccountId): string {
  return `account:${id}`
}
export function selectableKey(item: SelectableItem): string {
  if (item.kind === 'account') return accountRowKey(item.accountId)
  const key = rowKey(item)
  return item.accountId === undefined ? key : `${item.accountId}/${key}`
}

function rowKey(item: Exclude<SelectableItem, { kind: 'account' }>): string {
  switch (item.kind) {
    case 'chat':
      return `chat:${item.chat.id}`
    case 'channel':
      return `channel:${item.team.id}/${item.channel.id}`
    case 'team':
      return `team:${item.team.id}`
    case 'section':
      return `section:${item.section}`
    case 'more':
      return `more:${item.section}`
  }
}

// The cursor's row index: where `key` sits now, else the stored `fallback`
// index (the row went away, e.g. a chat was deleted or filtered out), clamped
// to `rowCount` (visible rows plus the synthetic new-chat row, if any).
export function resolveCursor(
  visible: SelectableItem[],
  rowCount: number,
  key: string | null,
  fallback: number,
): number {
  if (key === NEW_CHAT_ROW && rowCount > visible.length) return visible.length
  if (key !== null) {
    const i = visible.findIndex((it) => selectableKey(it) === key)
    if (i >= 0) return i
  }
  return clampCursor(fallback, rowCount)
}

// Store patch that moves the cursor to `index` of `visible`.
export function cursorAt(
  visible: SelectableItem[],
  index: number,
): { cursor: number; cursorKey: string | null } {
  const item = visible[index]
  return {
    cursor: index,
    cursorKey: item ? selectableKey(item) : index === visible.length ? NEW_CHAT_ROW : null,
  }
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
//      "Ola Kristian Berg-Nordmann" -> "Ola Kristian". Hyphenated
//      surnames have no whitespace inside so they count as one token.
// "Nordmann, Ola Berg" -> "Ola Berg" -> "Ola";
// "Kari Nordmann" -> "Kari";
// "Ola Kristian Berg-Nordmann" -> "Ola Kristian".
// Used in MessagePane so message rows show first/given names instead of
// the full "Nordmann, Ola Berg" / "Nordmann, Kari Anne" columns.
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

// The list the user sees and navigates: built, then narrowed by the filter.
// Every build-then-filter call site goes through here so one producer can be
// swapped in later.
export function visibleList(input: SelectableInput | UnifiedListInput): SelectableItem[] {
  if ('accounts' in input) return unifiedList(input)
  const items = buildSelectableList(input)
  return input.filter ? items.filter((it) => itemMatchesFilter(it, input.filter ?? '')) : items
}

// ---- unified sidebar (M2 F.2) ---------------------------------------------

// What the sidebar reads from one account: the list's inputs, plus
// memberPresence for its presence dots and realtimeState for its header.
const LIST_SLICE_KEYS = [
  'me',
  'chats',
  'teams',
  'channelsByTeam',
  'nameByUserId',
  'expandedChatSections',
  'unreadByChatId',
  'unreadMentionCount',
  'conn',
  'memberPresence',
  'realtimeState',
] as const satisfies readonly (keyof AccountSlice)[]
export type AccountListSlice = Pick<AccountSlice, (typeof LIST_SLICE_KEYS)[number]>

export type UnifiedListInput = Pick<SelectableInput, 'settings' | 'filter'> & {
  // Open accounts in configured order, keyed by alias.
  accounts: { alias: string; accountId: AccountId; slice: AccountListSlice }[]
}

// What unifiedListInput reads: the root state, or the parts of it a caller
// holds (the command palette).
export type UnifiedSource = Pick<AppState, 'account' | 'backgroundAccounts' | 'filter'> &
  AccountListSlice & {
    settings: Pick<Settings, 'accounts'> & NonNullable<SelectableInput['settings']>
  }

// The open accounts in settings.accounts order, a failed one (no session)
// included.
function openAccounts(s: UnifiedSource): UnifiedListInput['accounts'] {
  return s.settings.accounts.flatMap((alias) => {
    const accountId = accountRef(alias).id
    const slice: AccountListSlice | undefined =
      s.account?.id === accountId ? s : s.backgroundAccounts[accountId]
    return slice ? [{ alias, accountId, slice }] : []
  })
}

// The unified sidebar's input, or null below two open accounts (single mode,
// or concurrent mode with one account): the caller then builds the
// foreground's list as before.
export function unifiedListInput(s: UnifiedSource): UnifiedListInput | null {
  const accounts = openAccounts(s)
  return accounts.length < 2 ? null : { accounts, settings: s.settings, filter: s.filter }
}

// The unified sidebar is on: two or more accounts open. Also the condition
// for naming the foreground account in the pane title, composer, status bar
// and modals (F.4). Unlike SessionApi.running(), an open account whose start
// failed counts: it still has a section in the sidebar.
export function unifiedSidebar(s: UnifiedSource): boolean {
  return openAccounts(s).length > 1
}

// The foreground account's label where several accounts are open, else null.
export function foregroundLabel(s: AppState): string | null {
  return s.account && unifiedSidebar(s) ? s.account.label : null
}

// The account's header is collapsed in the unified sidebar and hides its rows.
// Counted from the open slots, not unifiedListInput: a background account's
// view of the store has its own slice in the flat fields. The key persists in
// config, so a later single-mode run must ignore it. A filter lifts collapse
// (see unifiedSidebarItems); `filter` is the root store's, since a background
// account's view resets it.
export function collapsedInSidebar(
  s: Pick<AppState, 'generationById' | 'settings'>,
  ref: AccountRef,
  filter: string,
): boolean {
  return (
    !filter &&
    ref.profile !== DEFAULT_PROFILE &&
    Object.keys(s.generationById).length > 1 &&
    !!s.settings.chatListCollapsedSections[accountCollapseKey(ref.profile)]
  )
}

// ` · <label>` after a title, or '' without a label.
export function labelSuffix(label: string | null | undefined): string {
  return label ? ` · ${label}` : ''
}

// A selector for unifiedListInput that returns the previous result while
// none of its inputs changed. The foreground's slice is the root state, a
// new object on every store change, so a component that memoised on the
// input object itself would rebuild the list on every keystroke.
export function cachedUnifiedListInput(): (s: AppState) => UnifiedListInput | null {
  let prev: UnifiedListInput | null = null
  return (s) => {
    const next = unifiedListInput(s)
    if (next === null || prev === null) return (prev = next)
    const same =
      next.settings === prev.settings &&
      next.filter === prev.filter &&
      next.accounts.length === prev.accounts.length &&
      next.accounts.every((a, i) => {
        const b = prev!.accounts[i]!
        return (
          a.accountId === b.accountId && LIST_SLICE_KEYS.every((k) => a.slice[k] === b.slice[k])
        )
      })
    return same ? prev : (prev = next)
  }
}

// An account's view of the collapsed map: unprefixed legacy keys apply to
// every account and are never rewritten; the account's own `<alias>/` keys
// win over them, an explicit false included (that reopens a section a legacy
// key collapses).
function collapsedFor(alias: string, all: Record<string, boolean>): Record<string, boolean> {
  const prefix = accountKeyPrefix(alias)
  const out = { ...all }
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v
  }
  return out
}

// One section per account: its header, then its own list (own collapse keys
// and `… N more` expansions) with every row tagged. A collapsed account shows
// its header only. Under a filter collapse is lifted, each account's rows are
// filtered as in single mode, and an account header stays only when one of
// its rows matched; nothing matching anywhere is an empty list.
function unifiedList(input: UnifiedListInput): SelectableItem[] {
  const filter = input.filter ?? ''
  const all = input.settings?.chatListCollapsedSections ?? {}
  // The cross-account block first, read from every open account's slice (a
  // collapsed account's favorites still show). A filter lists them in place.
  const favorites = (alias: string) =>
    filter ? { own: [], cross: [] } : accountFavorites(input.settings, alias)
  const out = favoritesSection(
    'crossFavorites',
    input.accounts.flatMap(({ alias, accountId, slice }) =>
      favoriteRows(
        { ...slice, settings: input.settings },
        new Set(favorites(alias).cross),
        'crossFavorites',
      ).map((row) => ({ ...row, accountId, alias })),
    ),
    all,
  )
  for (const { alias, slice } of input.accounts) {
    const ref = accountRef(alias)
    const collapsed = !filter && !!all[accountCollapseKey(alias)]
    const header: SelectableItem = {
      kind: 'account',
      accountId: ref.id,
      alias,
      label: ref.label,
      collapsed,
      unread: unreadTotals(slice.unreadByChatId).chats,
      mentions: slice.unreadMentionCount,
      conn: slice.conn,
    }
    if (collapsed) {
      out.push(header)
      continue
    }
    const rows = visibleList({
      ...slice,
      settings: { ...input.settings, chatListCollapsedSections: collapsedFor(alias, all) },
      filter,
      favorites: favorites(alias).own,
      elsewhere: favorites(alias).cross,
    })
    if (filter && rows.length === 0) continue
    out.push(header)
    for (const row of rows) out.push({ ...row, accountId: ref.id, alias })
  }
  return out
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
  // `… N more` row nor a section header ever coexists with a filter. An
  // account header is kept by unifiedList when one of its rows matched.
  if (item.kind === 'more' || item.kind === 'section' || item.kind === 'account') return false
  return item.channel.displayName.toLowerCase().includes(needle)
}
