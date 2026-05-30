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
  shortName,
  type SelectableItem,
} from '../state/selectables'
import type { ChatListDensity } from '../state/store'
import type { Presence } from '../types'
import { htmlToText } from '../text/html'
import { chromeRowsForChatList, computeChatListViewport } from './chatListViewport'
import { useTerminalRows } from './hooks/useTerminalRows'
import { useAppState, useTheme } from './StoreContext'
import type { PresenceColorKey, Theme } from './theme'

// Fallback width used when no listPaneWidth prop is supplied. Should
// not be reached in normal operation — App.tsx always passes the resolved
// width — but kept as a safe default so isolated renders don't crash.
const LIST_PANE_WIDTH_DEFAULT = 30

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'item'; item: SelectableItem; index: number }
  | { kind: 'synthetic-new-chat'; query: string; index: number }
  | { kind: 'spacer' }

// Cells available for the wrappable label/preview text after the
// presence/selector gutters and indent. Used to convert label length
// into a visual row count for the viewport slicing math.
function labelContentWidth(
  density: ChatListDensity,
  showPresence: boolean,
  indent: string,
  listPaneWidth: number,
): number {
  let width = listPaneWidth - 2 // round border (1 each side)
  width -= 1 // paddingRight on the column container
  if (density === 'cozy' || showPresence) width -= 3 // presence/type-glyph gutter
  if (density === 'cozy') width -= 2 // selector gutter
  width -= indent.length
  return Math.max(1, width)
}

function visualLines(text: string, contentWidth: number): number {
  if (!text) return 1
  return Math.max(1, Math.ceil(text.length / contentWidth))
}

function buildRows(
  items: SelectableItem[],
  density: ChatListDensity,
  syntheticNewChatQuery: string | null,
): Row[] {
  const rows: Row[] = []
  let firstChatEmitted = false
  let firstTeamEmitted = false
  let lastTeamId: string | null = null
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.kind === 'chat' && !firstChatEmitted && density === 'cozy') {
      rows.push({ kind: 'header', label: 'Chats' })
      firstChatEmitted = true
    }
    if (it.kind === 'team') {
      // 'cozy' density: blank row between Chats and the team list.
      // 'compact': skip the spacer so more rows fit in the viewport.
      // The team item itself renders as its own bold header below, so
      // no generic "Teams" section label is emitted.
      if (rows.length > 0 && density === 'cozy' && !firstTeamEmitted) {
        rows.push({ kind: 'spacer' })
      }
      firstTeamEmitted = true
      lastTeamId = it.team.id
    }
    if (it.kind === 'channel' && it.team.id !== lastTeamId) {
      // Channel without its team in the same render scope (team filtered? archived team?)
      // Defensive: still show it but without grouping.
      lastTeamId = it.team.id
    }
    rows.push({ kind: 'item', item: it, index: i })
  }
  if (syntheticNewChatQuery) {
    rows.push({
      kind: 'synthetic-new-chat',
      query: syntheticNewChatQuery,
      index: items.length,
    })
  }
  return rows
}

function rowLabel(
  item: SelectableItem,
  myUserId?: string,
  shortNames = false,
  nameByUserId?: Record<string, string>,
): string {
  // Chat rows respect the user's `chatListShortNames` setting. Default
  // (false) renders the full member display name; turning it on
  // collapses to first names. The MessagePane header always uses the
  // full form regardless.
  if (item.kind === 'chat')
    return chatLabel(item.chat, myUserId, { compact: shortNames, nameByUserId })
  if (item.kind === 'team') return item.team.displayName
  return `# ${item.label}`
}

// Cozy-density indent before the row label. Teams render flush-left
// as bold headers; channels indent two spaces under their team; chats
// stay flush-left so the focus indicator (`>`) is one column away
// from the name.
function rowIndent(item: SelectableItem): string {
  if (item.kind === 'channel') return '  '
  if (item.kind === 'team') return ''
  return ''
}

export function isNewChatQueryCandidate(filter: string): boolean {
  const query = filter.trim()
  if (query.length < 2) return false
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(query)) return true
  return /^[A-Za-z][A-Za-z .'-]{1,}$/.test(query)
}

// Presence dot for the "other" 1:1 chat member (or null when not a 1:1
// or when the user has hidden presence). Green/yellow/red/gray per
// theme. While the presence loop hasn't yet resolved a member's status
// (cold start or members-not-yet-hydrated), render a hollow `◯` in
// muted text so the user can see the row is *expected* to have presence
// rather than wondering why it's blank.
function presenceForChatItem(
  item: SelectableItem,
  myUserId: string | undefined,
  memberPresence: Record<string, Presence>,
  theme: Theme,
): { dot: string; color: string; wide?: boolean } | null {
  if (item.kind !== 'chat') return null
  const chat = item.chat
  if (chat.chatType !== 'oneOnOne') return null
  const members = chat.members ?? []
  // Members slice not yet hydrated → we know it's a 1:1 from chatType
  // but can't pin a userId yet. Show "loading".
  if (members.length === 0) return { dot: '◯', color: theme.mutedText }
  const other = members.find((m) => m.userId && m.userId !== myUserId)
  const userId = other?.userId
  // 1:1 with self (rare but possible) or member entry without a userId
  // — treat as no-presence rather than perpetually loading.
  if (!userId) return null
  const p = memberPresence[userId]
  if (!p) return { dot: '◯', color: theme.mutedText }
  const key = p.availability as PresenceColorKey
  const color = theme.presence[key] ?? theme.presence.PresenceUnknown
  return { dot: '●', color }
}

// Nerd-font glyphs distinguishing non-1:1 chats in the gutter where 1:1
// chats show their presence dot.  (U+EAB0) marks meeting chats,
//  (U+F0C0) marks group chats. 1:1 chats return null so the presence dot
// shows instead.
const CHAT_TYPE_GLYPH: Partial<Record<string, string>> = {
  meeting: '',
  group: '',
}

function chatTypeGlyph(
  item: SelectableItem,
  theme: Theme,
): { dot: string; color: string; wide?: boolean } | null {
  if (item.kind !== 'chat') return null
  const glyph = CHAT_TYPE_GLYPH[item.chat.chatType]
  // wide: nerd-font glyphs render two cells in most terminals, unlike the
  // single-cell presence dots — the gutter accounts for that when spacing.
  return glyph ? { dot: glyph, color: theme.mutedText, wide: true } : null
}

export function ChatList({ listPaneWidth = LIST_PANE_WIDTH_DEFAULT }: { listPaneWidth?: number }) {
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
  const showMessagePreviews = useAppState((s) => s.settings.showMessagePreviews)
  const showPresence = useAppState((s) => s.settings.showPresenceInList)
  const memberPresence = useAppState((s) => s.memberPresence)
  const nameByUserId = useAppState((s) => s.nameByUserId)
  const unreadByChatId = useAppState((s) => s.unreadByChatId)
  const tailEvents = useAppState((s) => s.settings.tailEvents)
  const tailNetwork = useAppState((s) => s.settings.tailNetwork)
  const tailDiagnostics = useAppState((s) => s.settings.tailDiagnostics)
  const theme = useTheme()
  const terminalRows = useTerminalRows()
  // Width of the (non-indented) preview rows: the full list pane minus the
  // round border and the column container's paddingRight.
  const previewContentWidth = listPaneWidth - 2 - 1
  const hasFilterBanner = inputZone === 'filter' || !!filter
  const anyTailEnabled = tailEvents || tailNetwork || tailDiagnostics
  const rowsVisible = Math.max(
    3,
    terminalRows - chromeRowsForChatList({ hasFilterBanner, anyTailEnabled }),
  )

  // Build selectables from individual slices so the hook only re-runs on
  // the data we actually depend on. (useAppState's selectors guarantee
  // referential stability of the store, not derived data, so we recompute
  // on every render - cheap given the list sizes.)
  const all = buildSelectableList({ me, chats, teams, channelsByTeam, nameByUserId })
  const items = filter ? all.filter((i) => itemMatchesFilter(i, filter)) : all
  const syntheticNewChatQuery =
    filter && items.length === 0 && isNewChatQueryCandidate(filter) ? filter.trim() : null

  const selectableCount = items.length + (syntheticNewChatQuery ? 1 : 0)
  const safeCursor = clampCursor(cursor, selectableCount)
  const rows = buildRows(items, density, syntheticNewChatQuery)

  // Visual height per logical row. Long chat names wrap onto multiple
  // visual lines, and unread previews add another line in cozy density;
  // the viewport math below counts visual lines so wrapping never
  // pushes adjacent rows off-screen or into the composer.
  const heights = rows.map((row) => {
    if (row.kind === 'header' || row.kind === 'spacer') return 1
    if (row.kind === 'synthetic-new-chat') {
      const cw = labelContentWidth(density, showPresence, '', listPaneWidth)
      return visualLines(`Create chat with "${row.query}"`, cw)
    }
    const indent = density === 'cozy' ? rowIndent(row.item) : ''
    const cw = labelContentWidth(density, showPresence, indent, listPaneWidth)
    const label = rowLabel(row.item, me?.id, shortNames, nameByUserId)
    const unread = row.item.kind === 'chat' ? unreadByChatId[row.item.chat.id] : undefined
    const hasMention = !!unread && unread.mentionCount > 0
    const hasUnread = Boolean(unread && (unread.unreadCount > 0 || unread.mentionCount > 0))
    const unreadBadge = hasMention ? ' @' : hasUnread ? ' ●' : ''
    let h = visualLines(label + unreadBadge, cw)
    if (showMessagePreviews && row.item.kind === 'chat') {
      const preview = previewLineForChat(row.item.chat, previewContentWidth)
      if (preview) h += visualLines(preview, previewContentWidth)
    }
    return h
  })

  // Anchor the viewport on the cursor row, then fill the visual-line
  // budget around it (backward first so j/k feels sticky, forward to
  // top up). Anchoring makes it impossible for the cursor to land on a
  // row outside the visible slice - earlier height-estimate-drift
  // produced exactly that "skip" bug, where cursor landed on a row
  // that was navigable but not painted.
  const cursorRowIdx = rows.findIndex((r) => r.kind === 'item' && r.index === safeCursor)
  const viewportRef = useRef(0)
  const { viewStart, visibleEnd } = computeChatListViewport(
    heights,
    cursorRowIdx,
    rowsVisible,
    viewportRef.current,
  )
  viewportRef.current = viewStart
  const visible = rows.slice(viewStart, visibleEnd)

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

  if (selectableCount === 0) {
    return (
      <Box flexDirection="column" paddingLeft={0} paddingRight={theme.layout.chatListPaddingRight}>
        {filterBanner}
        {density === 'cozy' && <Text bold={theme.emphasis.sectionHeadingBold}>Chats</Text>}
        <Text color={theme.mutedText}>
          {filter ? '  no matches' : conn === 'connecting' ? '  loading...' : '  (none)'}
        </Text>
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
      paddingLeft={0}
      paddingRight={theme.layout.chatListPaddingRight}
    >
      {filterBanner}
      {visible.map((row, i) => {
        if (row.kind === 'header') {
          return (
            <Box key={`h-${row.label}-${i}`} flexShrink={0}>
              <Text bold={theme.emphasis.sectionHeadingBold}>{row.label}</Text>
            </Box>
          )
        }
        if (row.kind === 'spacer') return <Box key={`sp-${i}`} height={1} flexShrink={0} />

        if (row.kind === 'synthetic-new-chat') {
          const isSelected = row.index === safeCursor
          return (
            <Box key={`new-chat-${row.query}`} flexDirection="row" flexShrink={0}>
              {density === 'cozy' && <Box width={2} flexShrink={0} />}
              {density === 'cozy' && (
                <Box width={2} flexShrink={0}>
                  <Text color={isSelected ? theme.selected : undefined}>
                    {isSelected ? '> ' : '  '}
                  </Text>
                </Box>
              )}
              <Box
                width={labelContentWidth(density, showPresence, '', listPaneWidth)}
                flexShrink={0}
              >
                <Text
                  color={isSelected ? theme.selected : theme.mutedText}
                  bold={isSelected && theme.emphasis.selectedBold}
                  wrap="wrap"
                >
                  {`Create chat with "${row.query}"`}
                </Text>
              </Box>
            </Box>
          )
        }

        // Teams render as non-selectable bold headers (no presence dot,
        // no selector gutter, no `#` prefix, no unread badge). Navigation
        // skips them via nextSelectableIndex in listKeys.ts.
        if (row.item.kind === 'team') {
          return (
            <Box key={`team-${row.index}`} flexDirection="row" flexShrink={0}>
              <Text
                bold={theme.emphasis.sectionHeadingBold}
                color={theme.mutedText}
                wrap="truncate-end"
              >
                {row.item.team.displayName}
              </Text>
            </Box>
          )
        }

        const isSelected = row.index === safeCursor
        const indent = density === 'cozy' ? rowIndent(row.item) : ''
        const label = rowLabel(row.item, me?.id, shortNames, nameByUserId)
        // Gutter glyph: 1:1 chats show a presence dot (when presence is
        // enabled), while meeting / group chats show a chat-type glyph so
        // they're distinguishable. Type glyphs need no fetched data, so they
        // render whenever the gutter is visible, regardless of showPresence.
        const presence =
          (showPresence ? presenceForChatItem(row.item, me?.id, memberPresence, theme) : null) ??
          chatTypeGlyph(row.item, theme)
        const unread = row.item.kind === 'chat' ? unreadByChatId[row.item.chat.id] : undefined
        const hasMention = !!unread && unread.mentionCount > 0
        const hasUnread = Boolean(unread && (unread.unreadCount > 0 || unread.mentionCount > 0))
        // Unread badge is a suffix, not a leading dot, so it can't be
        // confused with the presence column.
        const unreadBadge = hasMention ? ' @' : hasUnread ? ' ●' : ''
        // Layout per row (left → right):
        //   1. presence / type-glyph column (3 cols): dot/glyph/blank,
        //      always reserved when presence is enabled or in cozy mode so
        //      all rows column-align even when individual chats have no
        //      presence to show.
        //   2. selector column (cozy only): `> ` for the focused row,
        //      `  ` otherwise. Compact density saves those columns and
        //      relies on selected color/bold styling.
        //   3. indent (cozy: channel/team indent)
        //   4. label
        const showGutter = density === 'cozy' || showPresence
        // 3-cell gutter. Wide nerd-font type glyphs render two cells, so a
        // single trailing space leaves a gap before the name. Single-cell
        // presence dots get a leading space too, nudging them right so they
        // line up under the type glyphs (and a trailing space for the gap).
        const presenceText = presence
          ? presence.wide
            ? `${presence.dot} `
            : ` ${presence.dot} `
          : '   '
        const presenceColor = presence?.color
        // Non-indented last-message preview, independent of density. Read
        // chats render in muted gray, unread chats in the unread color.
        const preview =
          showMessagePreviews && row.item.kind === 'chat'
            ? previewLineForChat(row.item.chat, previewContentWidth)
            : ''
        // Background highlight for the selected row. Pad the label to fill
        // its column width so the background renders as a continuous bar
        // rather than only behind glyphs (Ink paints background per text
        // cell, not per Box). Mirror the MenuModal pad-to-width approach.
        const rowBg = isSelected ? (theme.selectedRowBackground ?? undefined) : undefined
        const labelWidth = labelContentWidth(density, showPresence, indent, listPaneWidth)
        const labelText = label + unreadBadge
        const labelPadded =
          isSelected && rowBg !== undefined
            ? labelText + ' '.repeat(Math.max(0, labelWidth - labelText.length))
            : labelText
        return (
          <Box key={`${row.item.kind}-${row.index}`} flexDirection="column" flexShrink={0}>
            <Box flexDirection="row" backgroundColor={rowBg}>
              {showGutter && (
                <Box width={3} flexShrink={0}>
                  <Text color={presenceColor}>{presenceText}</Text>
                </Box>
              )}
              {density === 'cozy' && (
                <Box width={2} flexShrink={0}>
                  <Text color={isSelected ? theme.selected : undefined} backgroundColor={rowBg}>
                    {isSelected ? '> ' : '  '}
                  </Text>
                </Box>
              )}
              {indent && (
                <Box width={indent.length} flexShrink={0}>
                  <Text>{indent}</Text>
                </Box>
              )}
              <Box width={labelWidth} flexShrink={0} backgroundColor={rowBg}>
                <Text
                  color={isSelected ? theme.selected : hasUnread ? theme.unread : undefined}
                  backgroundColor={rowBg}
                  bold={
                    (isSelected && theme.emphasis.selectedBold) ||
                    (hasUnread && theme.emphasis.unreadBold)
                  }
                  wrap="wrap"
                >
                  {labelPadded}
                </Text>
              </Box>
            </Box>
            {preview && (
              <Box width={previewContentWidth} flexShrink={0}>
                <Text
                  color={hasUnread ? theme.unread : theme.mutedText}
                  bold={hasUnread && theme.emphasis.unreadBold}
                  wrap="wrap"
                >
                  {preview}
                </Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function previewChat(chat: Extract<SelectableItem, { kind: 'chat' }>['chat']): string {
  const body = chat.lastMessagePreview?.body
  if (!body?.content) return ''
  const text =
    body.contentType === 'html'
      ? htmlToText(body.content)
      : body.content.replace(/\s+/g, ' ').trim()
  return text
}

// Truncate to at most `maxLines` visual lines worth of characters, adding an
// ellipsis when clipped. Keeps the rendered preview and the viewport height
// math in agreement.
function clampToLines(text: string, width: number, maxLines = 2): string {
  const max = Math.max(1, width) * maxLines
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

// "Sender: message" preview for a chat's last message, clamped to two lines.
// Empty string when the chat has no last-message preview to show.
function previewLineForChat(
  chat: Extract<SelectableItem, { kind: 'chat' }>['chat'],
  width: number,
): string {
  const text = previewChat(chat)
  if (!text) return ''
  const sender = chat.lastMessagePreview?.from?.user?.displayName
  const line = sender ? `${shortName(sender)}: ${text}` : text
  return clampToLines(line, width)
}
