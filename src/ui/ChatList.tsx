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
import { buildSelectableList, clampCursor, type SelectableItem } from '../state/selectables'
import { theme } from './theme'
import { useAppState } from './StoreContext'

const ROWS_VISIBLE = 18

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'item'; item: SelectableItem; index: number }
  | { kind: 'spacer' }

function buildRows(items: SelectableItem[]): Row[] {
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
      if (rows.length > 0) rows.push({ kind: 'spacer' })
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

function rowLabel(item: SelectableItem): string {
  if (item.kind === 'chat') return item.label
  if (item.kind === 'team') return item.team.displayName
  return `# ${item.label}`
}

function rowIndent(item: SelectableItem): string {
  if (item.kind === 'channel') return '    '
  if (item.kind === 'team') return '  '
  return '  '
}

export function ChatList() {
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const cursor = useAppState((s) => s.cursor)
  const me = useAppState((s) => s.me)
  const conn = useAppState((s) => s.conn)

  // Build selectables from individual slices so the hook only re-runs on
  // the data we actually depend on. (useAppState's selectors guarantee
  // referential stability of the store, not derived data, so we recompute
  // on every render - cheap given the list sizes.)
  const items = buildSelectableList({ me, chats, teams, channelsByTeam })

  const safeCursor = clampCursor(cursor, items.length)
  const rows = buildRows(items)

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

  if (items.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Chats</Text>
        <Text color="gray">{conn === 'connecting' ? '  loading...' : '  (none)'}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
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
        const label = rowLabel(row.item)
        const truncated =
          label.length > 24 - indent.length
            ? label.slice(0, 24 - indent.length - 1) + '…'
            : label
        return (
          <Text
            key={`${row.item.kind}-${row.index}`}
            color={isSelected ? theme.selected : undefined}
            bold={isSelected}
          >
            {`${marker}${indent.slice(1)}${truncated}`}
          </Text>
        )
      })}
    </Box>
  )
}
