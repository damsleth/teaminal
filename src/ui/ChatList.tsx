// Left pane: navigable list of chats and channels.
//
// Items are rendered in a flat sequence (chats, then teams + channels)
// matching buildSelectableList. Section and team headers are rows in that
// list too (see isSelectable for which ones take the cursor).
//
// A simple sliding viewport keeps the cursor on screen: the visible window
// starts at the latest scroll origin needed to include the cursor row.
// Scrolling is tracked in a ref since it derives from cursor changes;
// re-computed each render.

import { Box, Text, useApp, useStdout, type DOMElement } from 'ink'
import { useEffect, useRef, useState } from 'react'
import {
  ensureTeamPhoto,
  ensureUserPhoto,
  getImageData,
  ownedImageKey,
  teamPhotoKey,
  userPhotoKey,
} from '../state/imageCache'
import {
  avatarCols,
  avatarEscape,
  avatarPixels,
  avatarRows,
  iconEscape,
  iconKey,
  isIconKey,
} from './avatarImage'
import { rgbOf } from './theme'
import type { InlineImageSlots } from './inlineImageLayout'
import { isKittyCapable } from './kittyGraphics'
import { requestKittyPaint, setKittyOwner } from './kittyPainter'
import { initialsOf, PictureSlot } from './PictureSlot'
import { useSessionApi } from './SessionContext'
import {
  buildSelectableList,
  chatLabel,
  cursorAt,
  resolveCursor,
  itemMatchesFilter,
  shortName,
  type SelectableItem,
} from '../state/selectables'
import type { Presence } from '../types'
import wrapAnsi from 'wrap-ansi'
import { htmlToText } from '../text/html'
import { chromeRowsForChatList, computeChatListViewport } from './chatListViewport'
import { useTerminalRows } from './hooks/useTerminalRows'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import type { PresenceColorKey, Theme } from './theme'
import { fs } from './textSizing'

// Fallback width used when no listPaneWidth prop is supplied. Should
// not be reached in normal operation — App.tsx always passes the resolved
// width — but kept as a safe default so isolated renders don't crash.
const LIST_PANE_WIDTH_DEFAULT = 30

// Vim-style scrolloff: rows of context kept visible beyond the cursor
// while scrolling, so held-down j/k doesn't ride the pane edge.
const SCROLLOFF = 2

// Collapsed / expanded state marker on a section or team header. A collapsed
// header also shows its hidden row count so the section isn't invisible.
const COLLAPSED_GLYPH = '▸'
const EXPANDED_GLYPH = '▾'

type Row =
  | { kind: 'item'; item: SelectableItem; index: number }
  | { kind: 'synthetic-new-chat'; query: string; index: number }

// Presence / chat-type glyph column, before the chatListIndent gap.
const GLYPH_WIDTH = 2

// Cells available for the wrappable label/preview text after the
// presence gutter. Used to convert label length into a visual row count
// for the viewport slicing math.
function labelContentWidth(showPresence: boolean, indent: number, listPaneWidth: number): number {
  let width = listPaneWidth - 2 // round border (1 each side)
  width -= 1 // paddingRight on the column container
  if (showPresence) width -= GLYPH_WIDTH + indent
  return Math.max(1, width)
}

function visualLines(text: string, contentWidth: number): number {
  if (!text) return 1
  return Math.max(1, Math.ceil(text.length / contentWidth))
}

function buildRows(items: SelectableItem[], syntheticNewChatQuery: string | null): Row[] {
  const rows: Row[] = []
  let lastTeamId: string | null = null
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.kind === 'team') lastTeamId = it.team.id
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
  if (item.kind === 'section')
    return item.collapsed
      ? `${COLLAPSED_GLYPH} ${item.label} (${item.count})`
      : `${EXPANDED_GLYPH} ${item.label}`
  if (item.kind === 'team')
    return item.collapsed
      ? `${COLLAPSED_GLYPH} ${item.team.displayName}`
      : `${EXPANDED_GLYPH} ${item.team.displayName}`
  if (item.kind === 'more') return `… ${item.hidden} more`
  return `# ${item.label}`
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
  const cursorKey = useAppState((s) => s.cursorKey)
  const me = useAppState((s) => s.me)
  const conn = useAppState((s) => s.conn)
  const filter = useAppState((s) => s.filter)
  const expandedChatSections = useAppState((s) => s.expandedChatSections)
  const inputZone = useAppState((s) => s.inputZone)
  const chatListSort = useAppState((s) => s.settings.chatListSort)
  const chatListGroupByType = useAppState((s) => s.settings.chatListGroupByType)
  const chatListSectionCap = useAppState((s) => s.settings.chatListSectionCap)
  const chatListCollapsedSections = useAppState((s) => s.settings.chatListCollapsedSections)
  const shortNames = useAppState((s) => s.settings.chatListShortNames)
  const previewLines = useAppState((s) => s.settings.chatListPreviewLines)
  const showPresence = useAppState((s) => s.settings.showPresenceInList)
  const memberPresence = useAppState((s) => s.memberPresence)
  const nameByUserId = useAppState((s) => s.nameByUserId)
  const unreadByChatId = useAppState((s) => s.unreadByChatId)
  const tailEvents = useAppState((s) => s.settings.tailEvents)
  const tailNetwork = useAppState((s) => s.settings.tailNetwork)
  const tailDiagnostics = useAppState((s) => s.settings.tailDiagnostics)
  const theme = useTheme()
  const terminalRows = useTerminalRows()
  // Thumbnails (kitty graphics only): a picture column left of each chat /
  // channel row, rows tall, plus a gap column.
  const thumbnailSize = useAppState((s) => s.settings.chatListThumbnails)
  const accountId = useAppState((s) => s.account?.id)
  const modalOpen = useAppState((s) => s.modal != null)
  const session = useSessionApi()
  const { stdout } = useStdout()
  const { waitUntilRenderFlush } = useApp()
  const [, setPictureRevision] = useState(0)
  const listRef = useRef<DOMElement>(null)
  const pictureSlots = useRef<InlineImageSlots>(new Map())
  const thumbRows = isKittyCapable() ? avatarRows(thumbnailSize) : 0
  const thumbCols = avatarCols(thumbRows)
  const thumbColumn = thumbRows > 0 ? thumbCols + 1 : 0
  // Full row width: the list pane minus the round border and the column
  // container's paddingRight.
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
  const all = buildSelectableList({
    me,
    chats,
    teams,
    channelsByTeam,
    nameByUserId,
    settings: {
      chatListSort,
      chatListGroupByType,
      chatListSectionCap,
      chatListCollapsedSections,
    },
    filter,
    expandedChatSections,
  })
  const items = filter ? all.filter((i) => itemMatchesFilter(i, filter)) : all
  const syntheticNewChatQuery =
    filter && items.length === 0 && isNewChatQueryCandidate(filter) ? filter.trim() : null

  const selectableCount = items.length + (syntheticNewChatQuery ? 1 : 0)
  const safeCursor = resolveCursor(items, selectableCount, cursorKey, cursor)
  // Keep the fallback index on the row the key resolved to, so if that row
  // later goes away (deleted, filtered out) the cursor stays near it rather
  // than jumping to where it was before a reorder.
  const store = useAppStore()
  useEffect(() => {
    if (safeCursor !== cursor) store.set(cursorAt(items, safeCursor))
  })
  const rows = buildRows(items, syntheticNewChatQuery)
  const chatListGap = theme.layout.chatListGap
  const chatListIndent = theme.layout.chatListIndent
  const labelWidthFor = Math.max(
    1,
    labelContentWidth(showPresence, chatListIndent, listPaneWidth) - thumbColumn,
  )
  // Picture for a row: the other person's photo for 1:1 chats, the team
  // picture for channels. Group / meeting chats have no picture in Graph, so
  // they get their chat-type icon drawn at the same size.
  // ponytail: the icon uses the muted text color when it's hex / black /
  // white; a named palette color falls back to mid gray.
  const iconRgb = rgbOf(theme.mutedText) ?? [138, 138, 138]
  const pictureFor = (
    item: SelectableItem,
  ): { kind: 'user' | 'team' | 'icon'; id: string; key: string } | null => {
    if (thumbRows === 0) return null
    if (item.kind === 'channel')
      return { kind: 'team', id: item.team.id, key: teamPhotoKey(item.team.id) }
    if (
      item.kind === 'chat' &&
      (item.chat.chatType === 'group' || item.chat.chatType === 'meeting')
    ) {
      const icon = item.chat.chatType
      return { kind: 'icon', id: icon, key: iconKey(icon, iconRgb) }
    }
    if (item.kind !== 'chat' || item.chat.chatType !== 'oneOnOne') return null
    const other = (item.chat.members ?? []).find((m) => m.userId && m.userId !== me?.id)
    return other?.userId
      ? {
          kind: 'user',
          id: other.userId,
          key: userPhotoKey(other.userId, avatarPixels(thumbRows)),
        }
      : null
  }
  const hasPictureColumn = (item: SelectableItem) =>
    thumbColumn > 0 && (item.kind === 'chat' || item.kind === 'channel')

  // Visual height per logical row. Long chat names wrap onto multiple
  // visual lines, and previews add up to two more;
  // the viewport math below counts visual lines so wrapping never
  // pushes adjacent rows off-screen or into the composer.
  const heights = rows.map((row) => {
    if (row.kind === 'synthetic-new-chat') {
      return visualLines(`Create chat with "${row.query}"`, labelWidthFor)
    }
    const cw = labelWidthFor
    const label = rowLabel(row.item, me?.id, shortNames, nameByUserId)
    const unread = row.item.kind === 'chat' ? unreadByChatId[row.item.chat.id] : undefined
    const hasMention = !!unread && unread.mentionCount > 0
    const hasUnread = Boolean(unread && (unread.unreadCount > 0 || unread.mentionCount > 0))
    const unreadBadge = hasMention ? ' @' : hasUnread ? ' ●' : ''
    let h = visualLines(label + unreadBadge, cw)
    if (row.item.kind === 'chat') {
      const preview = previewLineForChat(row.item.chat, cw, previewLines)
      if (preview) h += preview.split('\n').length
    }
    if (hasPictureColumn(row.item)) h = Math.max(h, thumbRows)
    return row.item.kind === 'team' || row.item.kind === 'section' ? h : h + chatListGap
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
    SCROLLOFF,
  )
  viewportRef.current = viewStart
  const visible = rows.slice(viewStart, visibleEnd)

  // Fetch pictures for the visible rows only (idempotent per key).
  useEffect(() => {
    if (thumbRows === 0) return
    const client = session.client()
    const onChange = () => setPictureRevision((r) => r + 1)
    for (const row of visible) {
      if (row.kind !== 'item') continue
      const pic = pictureFor(row.item)
      if (pic?.kind === 'user')
        ensureUserPhoto(pic.id, avatarPixels(thumbRows), { client, onChange })
      else if (pic?.kind === 'team') ensureTeamPhoto(pic.id, { client, onChange })
    }
  })
  // Painted by the shared kitty painter, alongside the message pane's images.
  useEffect(() => {
    // Off: stay out of the painter, so chat-list re-renders (presence,
    // unread) don't clear and re-place the message pane's images.
    if (!stdout || thumbRows === 0) {
      setKittyOwner('chat-list', null)
      return
    }
    setKittyOwner('chat-list', {
      viewport: () => listRef.current,
      slots: pictureSlots.current,
      escape: (cacheKey, rows) => {
        if (isIconKey(cacheKey)) return iconEscape(cacheKey, rows)
        const data = getImageData(accountId, cacheKey)
        return data && accountId ? avatarEscape(ownedImageKey(accountId, cacheKey), data, rows) : ''
      },
    })
    requestKittyPaint({ stdout, flush: waitUntilRenderFlush, suppressed: modalOpen })
  })
  useEffect(
    () => () => {
      setKittyOwner('chat-list', null)
      requestKittyPaint()
    },
    [],
  )

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
      <Box flexDirection="column" paddingLeft={0} paddingRight={1}>
        {filterBanner}
        <Text color={theme.mutedText}>
          {filter ? '  no matches' : conn === 'connecting' ? '  loading...' : '  (none)'}
        </Text>
      </Box>
    )
  }

  return (
    <Box
      ref={listRef}
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
      paddingLeft={0}
      paddingRight={1}
    >
      {filterBanner}
      {visible.map((row) => {
        if (row.kind === 'synthetic-new-chat') {
          const isSelected = row.index === safeCursor
          return (
            <Box key={`new-chat-${row.query}`} flexDirection="row" flexShrink={0}>
              <Box width={labelWidthFor} flexShrink={0}>
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

        // Section / team headers render as bold rows with no presence dot,
        // selector gutter, `#` prefix, or unread badge. Navigation skips them
        // while expanded; a collapsed one is a cursor stop (see isSelectable)
        // and takes the selected color so it's clear what l/Enter reopens.
        // Headers are bold at rest too, so the selected color alone can't
        // carry focus (ANSI blue/cyan vanish on some palettes): a focused
        // header also gets the same full-width background bar as chat rows.
        if (row.item.kind === 'team' || row.item.kind === 'section') {
          const isSelected = row.index === safeCursor
          const restColor = row.item.kind === 'team' ? theme.mutedText : undefined
          const hdrBg = isSelected ? (theme.selectedRowBackground ?? undefined) : undefined
          const hdrLabel = rowLabel(row.item)
          return (
            <Box key={`hdr-${row.index}`} flexDirection="row" flexShrink={0}>
              <Text
                bold={theme.emphasis.sectionHeadingBold}
                color={isSelected ? theme.selected : restColor}
                backgroundColor={hdrBg}
                wrap="truncate-end"
              >
                {fs(
                  hdrBg ? hdrLabel.padEnd(previewContentWidth) : hdrLabel,
                  theme.fontSize.chatListHeader,
                  theme.fontSize.tightSpacing,
                )}
              </Text>
            </Box>
          )
        }

        const isSelected = row.index === safeCursor
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
        // Layout per row (left → right), when presence is enabled:
        //   1. glyph column (2 cols): dot/glyph/blank, reserved on every row
        //      so all rows column-align even without presence to show.
        //   2. chatListIndent gap
        //   3. label
        // The focused row relies on selected color/bold styling.
        // Wide nerd-font type glyphs fill both cells; single-cell presence
        // dots get a leading space so they line up under the type glyphs.
        const presenceText = presence ? (presence.wide ? presence.dot : ` ${presence.dot}`) : ''
        const presenceColor = presence?.color
        // Last-message preview, indented to line up under the label. Read
        // chats render in muted gray, unread chats in the unread color.
        const labelWidth = labelWidthFor
        const preview =
          row.item.kind === 'chat'
            ? previewLineForChat(row.item.chat, labelWidth, previewLines)
            : ''
        // Background highlight for the selected row. Pad the label to fill
        // its column width so the background renders as a continuous bar
        // rather than only behind glyphs (Ink paints background per text
        // cell, not per Box). Mirror the MenuModal pad-to-width approach.
        const rowBg = isSelected ? (theme.selectedRowBackground ?? undefined) : undefined
        const labelText = label + unreadBadge
        const labelPadded =
          isSelected && rowBg !== undefined
            ? labelText + ' '.repeat(Math.max(0, labelWidth - labelText.length))
            : labelText
        const withPicture = hasPictureColumn(row.item)
        const picture = withPicture ? pictureFor(row.item) : null
        const rowWidth = previewContentWidth - (withPicture ? thumbColumn : 0)
        return (
          <Box
            key={`${row.item.kind}-${row.index}`}
            flexDirection="row"
            flexShrink={0}
            marginBottom={chatListGap}
          >
            {withPicture && (
              <Box width={thumbColumn} flexShrink={0}>
                <PictureSlot
                  slots={pictureSlots.current}
                  cacheKey={picture?.key ?? null}
                  rows={thumbRows}
                  cols={thumbCols}
                  label={picture?.kind === 'icon' ? '' : initialsOf(label)}
                  theme={theme}
                />
              </Box>
            )}
            <Box flexDirection="column" flexShrink={0}>
              <Box flexDirection="row" backgroundColor={rowBg}>
                {showPresence && (
                  <Box width={GLYPH_WIDTH + chatListIndent} flexShrink={0}>
                    <Text color={presenceColor}>{presenceText}</Text>
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
                    {fs(labelPadded, theme.fontSize.chatListName, theme.fontSize.tightSpacing)}
                  </Text>
                </Box>
              </Box>
              {preview && (
                <Box width={rowWidth} flexShrink={0} paddingLeft={rowWidth - labelWidth}>
                  <Text
                    color={hasUnread ? theme.unread : theme.mutedText}
                    bold={hasUnread && theme.emphasis.unreadBold}
                    wrap="wrap"
                  >
                    {fs(preview, theme.fontSize.chatListPreview, theme.fontSize.tightSpacing)}
                  </Text>
                </Box>
              )}
            </Box>
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

// Word-wrap the way Ink does (wrap-ansi, hard) and keep at most `maxLines`
// lines, ending the last kept one in an ellipsis when clipped. The lines are
// joined with explicit newlines, so Ink paints exactly these rows and the
// viewport height math (line count) agrees.
export function clampToLines(text: string, width: number, maxLines: number): string {
  const w = Math.max(1, width)
  const lines = wrapAnsi(text, w, { hard: true }).split('\n')
  if (lines.length <= maxLines) return lines.join('\n')
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1]!.slice(0, w - 1).trimEnd()
  kept[maxLines - 1] = `${last}…`
  return kept.join('\n')
}

// "Sender: message" preview for a chat's last message, clamped to `maxLines`.
// Empty string when the chat has no last-message preview or previews are off.
function previewLineForChat(
  chat: Extract<SelectableItem, { kind: 'chat' }>['chat'],
  width: number,
  maxLines: number,
): string {
  if (maxLines <= 0) return ''
  const text = previewChat(chat)
  if (!text) return ''
  const sender = chat.lastMessagePreview?.from?.user?.displayName
  const line = sender ? `${shortName(sender)}: ${text}` : text
  return clampToLines(line, width, maxLines)
}
