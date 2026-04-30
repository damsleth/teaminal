// Left pane: navigable list of chats and channels.
//
// Items are rendered in a flat sequence (chats, then teams + channels)
// matching buildSelectableList; the rendered view inserts non-selectable
// "Chats" / "Teams" headers without consuming cursor indices.
//
// A simple sliding viewport keeps the cursor on screen: the visible window
// starts at the latest scroll origin needed to include the cursor row.
// Scrolling is tracked in a ref since it derives from cursor changes;
// re-computed each render.

import { Box, Text } from 'ink'
import { useRef } from 'react'
import {
  buildSelectableList,
  chatLabel,
  clampCursor,
  itemMatchesFilter,
  type SelectableItem,
} from '../state/selectables'
import type { ChatListDensity } from '../state/store'
import type { Presence } from '../types'
import { useAppState, useTheme } from './StoreContext'
import type { PresenceColorKey, Theme } from './theme'

const ROWS_VISIBLE = 18

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'item'; item: SelectableItem; index: number }
  | { kind: 'spacer' }

function buildRows(items: SelectableItem[], density: ChatListDensity): Row[] {
  const rows: Row[] = []
  let firstChatEmitted = false
  let lastTeamId: string | null = null
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.kind === 'chat' && !firstChatEmitted) {
      rows.push({ kind: 'header', label: 'Chats' })
      firstChatEmitted = true
    }
    if (it.kind === 'team') {
      // 'cozy' density: blank row between Chats and Teams sections.
      // 'compact': skip the spacer so more rows fit in the viewport.
      if (rows.length > 0 && density === 'cozy') rows.push({ kind: 'spacer' })
      rows.push({ kind: 'header', label: 'Teams' })
      lastTeamId = it.team.id
    }
    if (it.kind === 'channel' && it.team.id !== lastTeamId) {
      // Channel without its team in the same render scope (team filtered? archived team?)
      // Defensive: still show it but without grouping.
      lastTeamId = it.team.id
    }
    rows.push({ kind: 'item', item: it, index: i })
  }
  return rows
}

function rowLabel(item: SelectableItem, myUserId?: string, shortNames = false): string {
  // Chat rows respect the user's `chatListShortNames` setting. Default
  // (false) renders the full member display name; turning it on
  // collapses to first names. The MessagePane header always uses the
  // full form regardless.
  if (item.kind === 'chat') return chatLabel(item.chat, myUserId, { compact: shortNames })
  if (item.kind === 'team') return item.team.displayName
  return `# ${item.label}`
}

function rowIndent(item: SelectableItem): string {
  if (item.kind === 'channel') return '    '
  if (item.kind === 'team') return '  '
  return '  '
}

// Presence dot for the "other" 1:1 chat member (or null when not a 1:1
// or when the user has hidden presence). Green/yellow/red/gray per theme.
function presenceForChatItem(
  item: SelectableItem,
  myUserId: string | undefined,
  memberPresence: Record<string, Presence>,
  theme: Theme,
): { dot: string; color: string } | null {
  if (item.kind !== 'chat') return null
  const chat = item.chat
  if (chat.chatType !== 'oneOnOne') return null
  const other = (chat.members ?? []).find((m) => m.userId && m.userId !== myUserId)
  const userId = other?.userId
  if (!userId) return null
  const p = memberPresence[userId]
  if (!p) return null
  const key = p.availability as PresenceColorKey
  const color = theme.presence[key] ?? theme.presence.PresenceUnknown
  return { dot: '●', color }
}

export function ChatList() {
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const cursor = useAppState((s) => s.cursor)
  const me = useAppState((s) => s.me)
  const conn = useAppState((s) => s.conn)
  const filter = useAppState((s) => s.filter)
  const inputZone = useAppState((s) => s.inputZone)
  const density = useAppState((s) => s.settings.chatListDensity)
  const shortNames = useAppState((s) => s.settings.chatListShortNames)
  const showPresence = useAppState((s) => s.settings.showPresenceInList)
  const memberPresence = useAppState((s) => s.memberPresence)
  const theme = useTheme()

  // Build selectables from individual slices so the hook only re-runs on
  // the data we actually depend on. (useAppState's selectors guarantee
  // referential stability of the store, not derived data, so we recompute
  // on every render - cheap given the list sizes.)
  const all = buildSelectableList({ me, chats, teams, channelsByTeam })
  const items = filter ? all.filter((i) => itemMatchesFilter(i, filter)) : all

  const safeCursor = clampCursor(cursor, items.length)
  const rows = buildRows(items, density)

  // Find the visual index of the row holding the cursor item, then keep it
  // on-screen by sliding a window of size ROWS_VISIBLE.
  const cursorRowIdx = rows.findIndex((r) => r.kind === 'item' && r.index === safeCursor)
  const viewportRef = useRef(0)
  const viewStart = (() => {
    const cur = cursorRowIdx === -1 ? 0 : cursorRowIdx
    let start = viewportRef.current
    if (cur < start) start = cur
    if (cur >= start + ROWS_VISIBLE) start = cur - ROWS_VISIBLE + 1
    if (start < 0) start = 0
    viewportRef.current = start
    return start
  })()

  const visible = rows.slice(viewStart, viewStart + ROWS_VISIBLE)

  // Filter banner: shown while typing a filter, and when a filter is
  // applied but the user isn't actively editing it.
  const filterBanner =
    inputZone === 'filter' ? (
      <Text>
        <Text color="cyan">{'/ '}</Text>
        <Text>{filter}</Text>
        <Text color="cyan">█</Text>
      </Text>
    ) : filter ? (
      <Text color="gray">{`/ ${filter}  (Esc to clear)`}</Text>
    ) : null

  if (items.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {filterBanner}
        <Text bold>Chats</Text>
        <Text color="gray">
          {filter
            ? '  no matches'
            : conn === 'connecting'
              ? '  loading...'
              : '  (none)'}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {filterBanner}
      {visible.map((row, i) => {
        if (row.kind === 'header') {
          return (
            <Text key={`h-${row.label}-${i}`} bold>
              {row.label}
            </Text>
          )
        }
        if (row.kind === 'spacer') return <Box key={`sp-${i}`} height={1} />
        const isSelected = row.index === safeCursor
        const indent = rowIndent(row.item)
        const marker = isSelected ? '>' : ' '
        const label = rowLabel(row.item, me?.id, shortNames)
        const presence = showPresence
          ? presenceForChatItem(row.item, me?.id, memberPresence, theme)
          : null
        // Reserve 2 chars for the presence column when enabled so labels
        // align across rows that do/don't have a dot.
        const presencePad = showPresence ? 2 : 0
        const labelBudget = 24 - indent.length - presencePad
        const truncated =
          label.length > labelBudget
            ? label.slice(0, Math.max(0, labelBudget - 1)) + '…'
            : label
        return (
          <Text
            key={`${row.item.kind}-${row.index}`}
            color={isSelected ? theme.selected : undefined}
            bold={isSelected}
          >
            {`${marker}${indent.slice(1)}`}
            {showPresence ? (
              presence ? (
                <Text color={presence.color}>{`${presence.dot} `}</Text>
              ) : (
                <Text>{'  '}</Text>
              )
            ) : null}
            {truncated}
          </Text>
        )
      })}
    </Box>
  )
}
