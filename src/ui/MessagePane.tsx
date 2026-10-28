// Center pane: message timeline.
//
// Renders messages in chronological order (poller already reverses Graph's
// descending API result). System messages (messageType=systemEventMessage)
// are styled gray and labeled. Self messages get a subtle color cue.
// HTML bodies are converted via src/ui/html.htmlToText so <at>, <emoji>,
// <a>, and entity refs render correctly.

import { Box, Text, useStdout, useApp, type DOMElement } from 'ink'
import { createContext, useContext, type ReactNode, useEffect, useRef, useState } from 'react'
import { chatLabel, shortName } from '../state/selectables'
import { focusKey, type ReadReceipt, type TypingIndicator } from '../state/store'
import {
  groupChannelThreads,
  replyCountForRoot,
  type ChannelThreads,
} from '../state/channelThreads'
import type { Chat, ChatMessage, Channel, Team } from '../types'
import { extractFileAttachments, formatBytes } from '../text/fileAttachments'
import type { RichSpan } from '../text/html'
import { extractInlineImages, type InlineImageRef } from '../text/inlineImages'
import { reactionsSummary } from './reactions'
import { searchMessages } from './messageSearch'
import {
  effectiveSenderName,
  getQuotedReply,
  isMessageDeleted,
  isMessageEdited,
  messageBodyRich,
  messageBodyText,
  messagesForTimelineNavigation,
} from './renderableMessage'
import {
  buildMessageRows,
  chooseMessageRowsWindowStart,
  messageRenderRowHeight,
  messageRowsWindowEnd,
  readMessagePageState,
  shouldShowReactionRow,
  type LoadMoreState,
  type MessageRenderRow,
} from './messageRows'
import type { Theme } from './theme'
import { useSessionApi } from './SessionContext'
import { useAppState, useTheme } from './StoreContext'
import { TAIL_PANEL_ROWS } from './TailPanels'
import {
  isKittyCapable,
  isKittyRenderable,
  detectImageFormat,
  buildKittyImageEscape,
  fitKittyPlacement,
} from './kittyGraphics'
import {
  ensureImageFetched,
  ensureUserPhoto,
  getImageData,
  isPhotoKey,
  ownedImageKey,
  userPhotoKey,
} from '../state/imageCache'
import {
  avatarCols,
  avatarEscape,
  avatarPixels,
  avatarRows,
  iconEscape,
  initialsKey,
  isGeneratedKey,
} from './avatarImage'
import { requestKittyPaint, setKittyOwner } from './kittyPainter'
import { initialsOf, PictureSlot } from './PictureSlot'
import type { AccountId } from '../account'
import { messageFocusables } from './messageFocusables'
import { splitBodyLinkSpans, type BodySpan } from './bodySpans'
import { pickerAnchorCol } from './pickerAnchor'
import type { InlineImageSlots } from './inlineImageLayout'
import { localTime } from './localTime'
import { fs, fsTall, textSizingSupported } from './textSizing'

export { effectiveSenderName, isRenderableMessage } from './renderableMessage'

const TYPING_DOT = '…'
const ImageSlotsContext = createContext<InlineImageSlots>(new Map())

// Reserve for surrounding chrome so the message pane doesn't overflow the
// terminal. Header bar (3) + composer box (3) + status bar (1) + pane
// border (2) + safety pad (1) = 10. The chat name header adds an in-pane
// row plus a spacer below it (2), the loading-older indicator (when
// present) is one extra line, and the typing indicator (when present)
// is another.
const CHROME_RESERVED_ROWS = 10
const CHAT_HEADER_ROWS = 2
const MIN_VISIBLE_ROWS = 5
// Fallback for LIST_PANE_WIDTH when no prop is provided. Kept to avoid
// breaking isolated renders; App.tsx always passes the resolved width.
const LIST_PANE_WIDTH_DEFAULT = 30
// Fallback composer height for isolated renders; App passes the resolved one.
const DEFAULT_COMPOSER_ROWS = 3

export function MessagePane(props: {
  focusedMessageId?: string | null
  focusIndicatorActive?: boolean
  loadOlderState?: LoadMoreState
  /** Resolved chat-list pane width, used for the message width budget. */
  listPaneWidth?: number
  /**
   * Resolved composer box height. Part of the chrome below the pane, so it
   * feeds the timeline row budget.
   */
  composerRows?: number
}) {
  const focus = useAppState((s) => s.focus)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const messageCacheByConvo = useAppState((s) => s.messageCacheByConvo)
  const me = useAppState((s) => s.me)
  // Owner of every image in this pane (in-memory image maps are per account).
  const accountId = useAppState((s) => s.account?.id)
  const nameByUserId = useAppState((s) => s.nameByUserId)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const showTimestamps = useAppState((s) => s.settings.showTimestampsInPane)
  const centerDates = useAppState((s) => s.settings.centerDateMarkers)
  const avatarSize = useAppState((s) => s.settings.messageAvatars)
  const showSenderNames = useAppState((s) => s.settings.showSenderNamesInPane)
  const showOwnName = useAppState((s) => s.settings.showOwnNameInPane)
  const shortNames = useAppState((s) => s.settings.messagePaneShortNames)
  const showChatNameHeader = useAppState((s) => s.settings.showChatNameHeader)
  const reactionDisplayMode = useAppState((s) => s.settings.showReactions)
  const inputZone = useAppState((s) => s.inputZone)
  const searchQuery = useAppState((s) => s.messageSearchQuery)
  const focusIndicatorVisible = useAppState((s) => s.settings.messageFocusIndicatorEnabled)
  const focusIndicatorChar = useAppState((s) => s.settings.messageFocusIndicatorChar)
  const selfMessagesOnRight = useAppState((s) => s.settings.selfMessagesOnRight)
  const typingByConvo = useAppState((s) => s.typingByConvo)
  const readReceiptsByConvo = useAppState((s) => s.readReceiptsByConvo)
  const inlineImages = useAppState((s) => s.settings.inlineImages)
  const inlineImageMaxRows = useAppState((s) => s.settings.inlineImageMaxRows)
  // True when no status bar occupies the bottom row (hidden, or moved to the
  // top): this frees a row in the timeline budget.
  const statusBarHidden = useAppState((s) => s.settings.statusBarPosition !== 'bottom')
  const reactionPickerOpen = useAppState((s) => s.modal?.kind === 'reaction-picker')
  // Any open modal renders as a centred overlay on top of this pane. Kitty
  // images are written out-of-band at a positive z-index, so they composite
  // above all terminal text - including the overlay - and would paint over the
  // modal. Suppress inline images while a modal is open so the overlay stays
  // in front; they redraw when it closes.
  const modalOpen = useAppState((s) => s.modal != null)
  // Which focusable (image / link) inside the focused message the per-message
  // focus ring currently points at, so the focused link/image can get the
  // strong highlight. 0 = the message body itself (no attachment focused).
  const focusedAttachmentIndex = useAppState((s) => s.focusedAttachmentIndex)
  const theme = useTheme()
  const session = useSessionApi()

  const listPaneWidth = props.listPaneWidth ?? LIST_PANE_WIDTH_DEFAULT
  const composerRows = props.composerRows ?? DEFAULT_COMPOSER_ROWS
  // The tail strip sits between this pane and the composer, so its rows count
  // toward the timeline budget. It renders only when a tail is enabled — and is
  // hidden entirely while a modal is open, which is also when image painting
  // is suppressed, so enabled == visible for image layout purposes.
  const tailRows = useAppState(
    (s) => s.settings.tailEvents || s.settings.tailNetwork || s.settings.tailDiagnostics,
  )
    ? TAIL_PANEL_ROWS
    : 0

  const [, setImageRevision] = useState(0)
  const kittyEnabled = inlineImages === 'auto' && isKittyCapable()

  // Track terminal height live so the message slice fills the available
  // space. Without this we capped at 20 rows even on tall terminals.
  const { stdout } = useStdout()
  const [terminalSize, setTerminalSize] = useState({
    rows: stdout?.rows ?? 24,
    columns: stdout?.columns ?? 80,
  })
  useEffect(() => {
    if (!stdout) return
    const onResize = () =>
      setTerminalSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 })
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  const windowStartRef = useRef(0)
  const paneRef = useRef<DOMElement>(null)
  const imageSlots = useRef<InlineImageSlots>(new Map())
  const { waitUntilRenderFlush } = useApp()

  const isListFocus = focus.kind === 'list'
  const conv = focusKey(focus) ?? ''
  const rawMessages = messagesByConvo[conv] ?? []
  // The navigable/rendered timeline: unrenderable system rows dropped (blank
  // "(system)" rows and undecodable events), and for a CHANNEL focus reduced
  // to thread roots — replies are reached via the thread view. This is the
  // same helper the cursor index space uses (App / messageFocusables /
  // useClampMessageCursor), so render and navigation stay in lockstep.
  const messages = messagesForTimelineNavigation(rawMessages, focus)
  // Channel reply-count badges come from grouping the full loaded stream
  // (roots + replies are both in rawMessages) — no Graph /replies fetch.
  const channelThreads: ChannelThreads | null =
    focus.kind === 'channel' ? groupChannelThreads(rawMessages) : null
  // Repurposed theme.layout knobs: left indent of the sender-name/body block,
  // and the blank rows inserted after each message group.
  const bodyIndent = theme.layout.paneHeaderPaddingLeft
  // A .5 gap draws sender headers as tall (2-row) kitty text-sizing lines:
  // the name at 1.5x size sits at the bottom, half a row of air above it and
  // none before the body. The sender font size scales it down from there.
  // Without OSC 66 the gap rounds to whole rows.
  const rawGap = theme.layout.paneHeaderMarginBottom
  const tallHeaders = rawGap % 1 !== 0 && textSizingSupported()
  const messageGap = tallHeaders ? Math.floor(rawGap) : Math.round(rawGap)
  // The sender line holds the name and/or timestamp; with neither it's gone.
  const showNameFor = (m: ChatMessage): boolean =>
    showSenderNames && (showOwnName || !me?.id || m.from?.user?.id !== me.id)
  // Profile pictures (kitty graphics only): rows tall, plus a gap column.
  const avRows = isKittyCapable() ? avatarRows(avatarSize) : 0
  const avCols = avatarCols(avRows)
  const avatarColumn = avRows > 0 ? avCols + 1 : 0
  const avatarStarts = avRows > 0 ? avatarRunStarts(messages, me?.id) : null
  const avatarFor = (m: ChatMessage): MessageAvatar | null =>
    avRows > 0
      ? {
          rows: avRows,
          cols: avCols,
          column: avatarColumn,
          userId: avatarStarts?.has(m.id) ? (m.from?.user?.id ?? null) : null,
        }
      : null
  const minRows = (m: ChatMessage): number => (avatarStarts?.has(m.id) ? avRows : 0)
  const transientTimes = showTimestamps === 'transient' ? transientTimestampIds(messages) : null
  const showTimeFor = (m: ChatMessage): boolean =>
    showTimestamps === 'on' || (transientTimes?.has(m.id) ?? false)
  const headerRows = (m: ChatMessage): number =>
    showTimeFor(m) || showNameFor(m) ? (tallHeaders ? 2 : 1) : 0
  const cache = messageCacheByConvo[conv]
  const headerLabel = isListFocus
    ? ''
    : headerForFocus(
        focus as Exclude<typeof focus, { kind: 'list' }>,
        chats,
        teams,
        channelsByTeam,
        me?.id,
        nameByUserId,
      )
  const pageState = readMessagePageState(cache ?? messages)
  const loadMoreState =
    props.loadOlderState ??
    (pageState.loading
      ? 'loading'
      : pageState.error
        ? 'error'
        : pageState.hasOlder
          ? 'idle'
          : 'unavailable')
  const isLoadingOlder = loadMoreState === 'loading'
  const chatHeaderRows = showChatNameHeader ? CHAT_HEADER_ROWS : 0
  const typingActive = (typingByConvo[conv] ?? []).length > 0
  const reservedDynamic = (isLoadingOlder ? 1 : 0) + (typingActive ? 1 : 0)
  const chromeRows = CHROME_RESERVED_ROWS - (statusBarHidden ? 1 : 0)
  const rowBudget = Math.max(
    MIN_VISIBLE_ROWS,
    terminalSize.rows -
      chromeRows -
      chatHeaderRows -
      reservedDynamic -
      tailRows -
      (composerRows - DEFAULT_COMPOSER_ROWS) -
      (inputZone === 'message-search' ? 1 : 0),
  )
  // Body wrap width estimate for the viewport budget: pane content (terminal
  // minus the chat-list pane and its border) minus the body indent. Bodies now
  // start near the left edge instead of after a deep sender column.
  // A rounded background adds a half-block frame row / column on each side.
  const bubble = theme.layout.textBackgroundRadius > 0 ? 1 : 0
  const bgPadX = theme.layout.textBackgroundPaddingX + bubble
  const bodyPaddingY = theme.layout.textBackgroundPaddingY + bubble
  // layout.messageMaxWidth narrows each message (not its sender line) to
  // that percent of the space beside the avatar column, centered: equal
  // margins left and right.
  const paneColumns = terminalSize.columns - listPaneWidth - 2
  const conversationColumns = Math.floor(
    ((paneColumns - avatarColumn) * theme.layout.messageMaxWidth) / 100,
  )
  const conversationMargin = Math.floor((paneColumns - avatarColumn - conversationColumns) / 2)
  const messageTextColumns = Math.max(12, conversationColumns - bodyIndent - 2 * bgPadX)
  // Cell budget for an inline image (conversation column minus the gutter).
  const imgCols = Math.max(12, conversationColumns - 18)
  // Rows a message's inline images occupy: each loaded image takes its fitted
  // height (no label), each still-loading image takes one `[img]` label row.
  // Recomputed each render (imageRevision bumps on load) so layout, the
  // reserved blank rows, and the Kitty placement all agree.
  const imageRowsForMessage = (message: ChatMessage): number =>
    extractInlineImages(message).reduce((sum, ref) => {
      const reserved = inlineImageReservedRows(
        accountId,
        ref.cacheKey,
        imgCols,
        inlineImageMaxRows,
        kittyEnabled,
      )
      return sum + (reserved === null ? 1 : reserved)
    }, 0)
  const allRows = buildMessageRows(messages, {
    showLoadMoreRow: messages.length > 0 && !pageState.fullyLoaded,
    loadMoreState,
  })
  const windowStart = chooseMessageRowsWindowStart(allRows, {
    focusedMessageId: props.focusedMessageId,
    // Keep the focused message in view while the reaction picker is open even
    // though inputZone is 'menu' — the system emoji picker anchors to its row.
    focusActive: props.focusIndicatorActive === true || reactionPickerOpen,
    imageRowsForMessage,
    messageTextColumns,
    messageGap,
    headerRows,
    minRows,
    bodyPaddingY,
    reactionDisplayMode,
    rowBudget,
    previousStart: windowStartRef.current,
  })
  windowStartRef.current = windowStart
  const windowEnd = messageRowsWindowEnd(allRows, windowStart, {
    focusedMessageId: props.focusedMessageId,
    imageRowsForMessage,
    messageTextColumns,
    messageGap,
    headerRows,
    minRows,
    bodyPaddingY,
    reactionDisplayMode,
    rowBudget,
  })
  const rows = allRows.slice(windowStart, windowEnd)
  const showingHistoryTop = rows.length > 0 && allRows.length > 0 && rows[0] === allRows[0]
  const showFocusIndicator =
    props.focusIndicatorActive === true && focusIndicatorVisible && messages.length > 0

  // Search bar (S1) is rendered above the timeline when active. The
  // matching messages are highlighted at the row level via the existing
  // focused-message indicator (the keys handler updates messageCursor
  // on Enter / n), so the search bar itself is just an input echo.
  const searchActive = inputZone === 'message-search'
  const hits = searchActive ? searchMessages(messages, searchQuery) : []

  // Trigger image fetches for every visible message. Cheap and idempotent:
  // ensureImageFetched short-circuits on any key already loading/ready, so
  // running this on each render costs a map lookup per image. The
  // imageRevision counter is bumped by its onChange callback so the component
  // re-renders once an image transitions loading → ready.
  useEffect(() => {
    if (!kittyEnabled) return
    const client = session.client()
    for (const row of rows) {
      if (row.kind !== 'message') continue
      for (const ref of extractInlineImages(row.message)) {
        ensureImageFetched(
          ref.sourcePath,
          ref.cacheKey,
          { contentType: ref.contentType, name: ref.name },
          {
            client,
            isExternal: ref.isExternal,
            ...(ref.objectId ? { objectId: ref.objectId } : {}),
            ...(ref.region ? { region: ref.region } : {}),
            onChange: () => setImageRevision((r) => r + 1),
          },
        )
      }
    }
  })

  // Profile photos for the visible run starts (same idempotent pattern).
  useEffect(() => {
    if (!avatarStarts) return
    const client = session.client()
    for (const row of rows) {
      if (row.kind !== 'message' || !avatarStarts.has(row.message.id)) continue
      const userId = row.message.from?.user?.id
      if (userId)
        ensureUserPhoto(userId, avatarPixels(avRows), {
          client,
          onChange: () => setImageRevision((r) => r + 1),
        })
    }
  })

  // Yoga owns the positions, including unused space below short timelines,
  // wrapped text and dynamic chrome. Wait for Ink's throttled text frame
  // before reading those positions and placing graphics over their slots.
  // The shared painter (kittyPainter) does the clearing and placing, so the
  // chat list's thumbnails and these images don't erase each other.
  useEffect(() => {
    if (!stdout || !isKittyCapable()) return
    setKittyOwner('messages', {
      viewport: () => paneRef.current,
      slots: imageSlots.current,
      escape: (cacheKey, rows, fallbackKey) => {
        if (isGeneratedKey(cacheKey)) return iconEscape(cacheKey, rows)
        const data = getImageData(accountId, cacheKey)
        const owned = accountId ? ownedImageKey(accountId, cacheKey) : null
        if (isPhotoKey(cacheKey)) {
          const photo = data && owned ? avatarEscape(owned, data, rows) : ''
          return photo || (fallbackKey ? iconEscape(fallbackKey, rows) : '')
        }
        return data && owned ? buildKittyImageEscape(owned, data, { rows, reservedRows: rows }) : ''
      },
    })
    requestKittyPaint({ stdout, flush: waitUntilRenderFlush, suppressed: modalOpen })
  })
  useEffect(
    () => () => {
      setKittyOwner('messages', null)
      requestKittyPaint()
    },
    [],
  )

  // While the reaction picker is open we delegate to the macOS Character
  // Viewer, which anchors to the terminal's text cursor (after an Ink render
  // that sits at the bottom-left prompt). Park the cursor on the focused
  // message's row at the END of the message body's last wrapped line — so the
  // system picker pops at the trailing edge of the message being reacted to,
  // rather than the far-left of the message pane. Re-applied after every
  // render so a background re-render can't snap it back. Best-effort: row and
  // column are approximate; exact placement is up to the terminal/IME.
  useEffect(() => {
    if (!stdout || !reactionPickerOpen) return
    const idx = rows.findIndex(
      (r) => r.kind === 'message' && r.message.id === props.focusedMessageId,
    )
    if (idx < 0) return
    const heightOpts = {
      imageRowsForMessage,
      messageTextColumns,
      messageGap,
      headerRows,
      minRows,
      bodyPaddingY,
      reactionDisplayMode,
    }
    let rowsBefore = 0
    for (let i = 0; i < idx; i++) rowsBefore += messageRenderRowHeight(rows[i]!, heightOpts)
    // Chrome above the pane content: header bar (3) + message-pane top border
    // (1); pane content then starts on the next row. Add the in-pane prelude
    // (chat name header, search bar, loading-older line) that pushes messages down,
    // plus the focused message's own sender-header line so the anchor lands on
    // the body rather than the name.
    const preludeRows =
      chatHeaderRows + (searchActive ? 1 : 0) + (isLoadingOlder && !showingHistoryTop ? 1 : 0)
    const row = 4 + 1 + preludeRows + rowsBefore + 1 + bodyPaddingY
    // Compute the column at the end of the focused message body's last wrapped
    // line. `messageBodyTerminalColumn` gives the 1-based terminal column where
    // the body text begins; `pickerAnchorCol` adds the display width of the
    // last wrapped line so the picker anchors to the trailing edge.
    const focusedRow = rows[idx]
    const focusedMsg = focusedRow?.kind === 'message' ? focusedRow.message : null
    const bodyText = focusedMsg ? messageBodyText(focusedMsg) : ''
    const bodyStartCol = messageBodyTerminalColumn({
      bodyIndent: bodyIndent + bgPadX,
      listPaneWidth: listPaneWidth + conversationMargin + avatarColumn,
    })
    const fallbackCol = listPaneWidth + 3
    const col = pickerAnchorCol({
      bodyText,
      bodyStartCol,
      messageTextColumns,
      fallbackCol,
      terminalColumns: terminalSize.columns,
    })
    stdout.write(`\x1b[${row};${col}H`)
  })

  if (isListFocus) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={0}>
        <Text color="gray">Select a chat or channel · Enter to open · q to quit</Text>
      </Box>
    )
  }

  return (
    <ImageSlotsContext.Provider value={imageSlots.current}>
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
        paddingX={0}
      >
        {showChatNameHeader && (
          <Box paddingLeft={bodyIndent} marginBottom={1} flexShrink={0}>
            <Text bold={theme.emphasis.sectionHeadingBold}>
              {fs(headerLabel, theme.fontSize.paneHeader, theme.fontSize.tightSpacing)}
            </Text>
          </Box>
        )}
        {searchActive && (
          <Box flexShrink={0}>
            <Text>
              <Text color={theme.mutedText}>/ </Text>
              {searchQuery}
              <Text color="cyan">█</Text>
              <Text color={theme.mutedText}>
                {'  '}
                {hits.length} hit(s) · enter jumps · n step · esc closes
              </Text>
            </Text>
          </Box>
        )}
        {isLoadingOlder && !showingHistoryTop && (
          <Box flexShrink={0}>
            <Text color={theme.mutedText}>… loading older messages</Text>
          </Box>
        )}
        {/* The row window is sized from estimated heights; when wrapping makes
            the real content taller than the pane, Yoga would shrink rows (Ink
            boxes default to flexShrink 1) and a collapsed row — often a
            one-line day header — gets painted over by its neighbour. Rows
            never shrink instead: the viewport clips the overflow, at the top
            while the window holds the newest message (flex-end), at the
            bottom when scrolled back to an older focused one. flexGrow keeps
            short content top-aligned. Inline images are bounded by this
            viewport (paneRef), so a top-clipped image can't paint over the
            header / search bar above it. */}
        <Box
          ref={paneRef}
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
          justifyContent={windowEnd === allRows.length ? 'flex-end' : 'flex-start'}
        >
          <Box flexDirection="column" flexGrow={1} flexShrink={0}>
            {messages.length === 0 ? (
              <Text color="gray"> loading...</Text>
            ) : (
              <>
                {rows.map((row) => (
                  <TimelineRow
                    key={
                      row.kind === 'message'
                        ? row.message.id
                        : row.kind === 'date'
                          ? row.key
                          : 'load-more'
                    }
                    row={row}
                    focused={
                      row.kind === 'message' &&
                      showFocusIndicator &&
                      row.message.id === props.focusedMessageId
                    }
                    focusIndicatorChar={focusIndicatorChar}
                    focusedMessageId={props.focusedMessageId}
                    focusedAttachmentIndex={focusedAttachmentIndex}
                    myUserId={me?.id}
                    reactionDisplayMode={reactionDisplayMode}
                    readReceipts={readReceiptsByConvo[conv]}
                    imgCols={imgCols}
                    inlineImageMaxRows={inlineImageMaxRows}
                    inlineImagesPainted={kittyEnabled}
                    selfMessagesOnRight={selfMessagesOnRight}
                    bodyIndent={bodyIndent}
                    messageGap={messageGap}
                    tallHeader={tallHeaders}
                    shortNames={shortNames}
                    showTimestamp={
                      row.kind === 'message' ? showTimeFor(row.message) : showTimestamps !== 'off'
                    }
                    centerDate={centerDates}
                    avatar={row.kind === 'message' ? avatarFor(row.message) : null}
                    showSenderName={
                      row.kind === 'message' ? showNameFor(row.message) : showSenderNames
                    }
                    theme={theme}
                    threadMeta={
                      channelThreads && row.kind === 'message'
                        ? replyBadgeFor(channelThreads, row.message.id)
                        : undefined
                    }
                  />
                ))}
                <TypingLine typing={conv ? (typingByConvo[conv] ?? []) : []} theme={theme} />
              </>
            )}
          </Box>
        </Box>
      </Box>
    </ImageSlotsContext.Provider>
  )
}

// The profile-picture column of one message: its size, and whose picture
// to draw (null = keep the column empty, e.g. later messages in a run).
type MessageAvatar = { rows: number; cols: number; column: number; userId: string | null }

// Messages that start a run from one sender (other people only): where a
// profile picture goes.
export function avatarRunStarts(messages: ChatMessage[], myUserId?: string): Set<string> {
  const ids = new Set<string>()
  let prev: string | null = null
  for (const m of messages) {
    const sender = m.messageType === 'systemEventMessage' ? null : (m.from?.user?.id ?? null)
    if (sender && sender !== myUserId && sender !== prev) ids.add(m.id)
    prev = sender
  }
  return ids
}

// Gap after which 'transient' timestamps show again.
const TRANSIENT_TIMESTAMP_GAP_MS = 15 * 60 * 1000

// Messages that get a timestamp in 'transient' mode: the first one, and any
// sent at least TRANSIENT_TIMESTAMP_GAP_MS after the message before it.
export function transientTimestampIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  let prev: number | null = null
  for (const m of messages) {
    const at = Date.parse(m.createdDateTime)
    if (prev === null || Number.isNaN(at) || at - prev >= TRANSIENT_TIMESTAMP_GAP_MS) ids.add(m.id)
    if (!Number.isNaN(at)) prev = at
  }
  return ids
}

// Half blocks drawn in the background color: half a cell of air on each
// side and chamfered corners, the terminal's closest thing to a rounded box.
export const BUBBLE_BORDER = {
  topLeft: '▗',
  top: '▄',
  topRight: '▖',
  left: '▐',
  right: '▌',
  bottomLeft: '▝',
  bottom: '▀',
  bottomRight: '▘',
}
const BLANK_BUBBLE_BORDER = {
  topLeft: ' ',
  top: ' ',
  topRight: ' ',
  left: ' ',
  right: ' ',
  bottomLeft: ' ',
  bottom: ' ',
  bottomRight: ' ',
}

function TimelineRow(props: {
  row: MessageRenderRow
  focused: boolean
  focusIndicatorChar: string
  focusedMessageId?: string | null
  focusedAttachmentIndex?: number
  myUserId?: string
  reactionDisplayMode: 'off' | 'current' | 'all'
  readReceipts?: Record<string, ReadReceipt>
  imgCols: number
  inlineImageMaxRows: number
  inlineImagesPainted: boolean
  selfMessagesOnRight: boolean
  bodyIndent: number
  messageGap: number
  tallHeader: boolean
  shortNames: boolean
  showTimestamp: boolean
  showSenderName: boolean
  centerDate: boolean
  avatar?: MessageAvatar | null
  theme: Theme
  threadMeta?: ReplyBadge
}) {
  if (props.row.kind === 'date') {
    const theme = props.theme
    return (
      <Box justifyContent={props.centerDate ? 'center' : undefined}>
        {!props.centerDate && props.showTimestamp && <Box width={1} flexShrink={0} />}
        {!props.centerDate && theme.layout.dateMarkerIndent > 0 && (
          <Box width={theme.layout.dateMarkerIndent} flexShrink={0} />
        )}
        <Text color={theme.dateMarker} bold={theme.emphasis.dateMarkerBold}>
          {fs(props.row.label, theme.fontSize.dateMarker, theme.fontSize.tightSpacing)}
        </Text>
      </Box>
    )
  }
  if (props.row.kind === 'loadMore') {
    const active = props.row.state === 'idle'
    return (
      <Box>
        {props.showTimestamp && <Box width={1} flexShrink={0} />}
        <Text color={active ? props.theme.selected : 'gray'} wrap="truncate-end">
          {active ? 'U/K ' : ''}
          {props.row.label}
        </Text>
      </Box>
    )
  }
  return (
    <MessageRow
      message={props.row.message}
      focused={props.focused}
      focusIndicatorChar={props.focusIndicatorChar}
      focusedMessageId={props.focusedMessageId}
      focusedAttachmentIndex={props.focusedAttachmentIndex}
      myUserId={props.myUserId}
      reactionDisplayMode={props.reactionDisplayMode}
      readReceipts={props.readReceipts}
      imgCols={props.imgCols}
      inlineImageMaxRows={props.inlineImageMaxRows}
      inlineImagesPainted={props.inlineImagesPainted}
      selfMessagesOnRight={props.selfMessagesOnRight}
      bodyIndent={props.bodyIndent}
      messageGap={props.messageGap}
      tallHeader={props.tallHeader}
      shortNames={props.shortNames}
      showTimestamp={props.showTimestamp}
      showSenderName={props.showSenderName}
      avatar={props.avatar}
      theme={props.theme}
      threadMeta={props.threadMeta}
    />
  )
}

function MessageRow(props: {
  message: ChatMessage
  focused: boolean
  focusIndicatorChar: string
  focusedMessageId?: string | null
  focusedAttachmentIndex?: number
  myUserId?: string
  reactionDisplayMode: 'off' | 'current' | 'all'
  readReceipts?: Record<string, ReadReceipt>
  imgCols: number
  inlineImageMaxRows: number
  inlineImagesPainted: boolean
  selfMessagesOnRight: boolean
  bodyIndent: number
  messageGap: number
  tallHeader: boolean
  shortNames: boolean
  showTimestamp: boolean
  showSenderName: boolean
  avatar?: MessageAvatar | null
  theme: Theme
  threadMeta?: ReplyBadge
}) {
  const { theme } = props
  const slots = useContext(ImageSlotsContext)
  const m = props.message
  const isSelf = !!props.myUserId && m.from?.user?.id === props.myUserId
  const flip = props.selfMessagesOnRight && isSelf
  const time = localTime(m.createdDateTime)
  const isSystem = m.messageType === 'systemEventMessage'
  // The sender name now gets its own line above the body, so it is shown in
  // full (the header line truncates only if it overruns the pane). System
  // rows have no sender; their text occupies the single line.
  const senderRaw = isSystem ? '' : (effectiveSenderName(m) ?? '')
  const senderName =
    senderRaw && props.showSenderName ? (props.shortNames ? shortName(senderRaw) : senderRaw) : ''
  const isSending = m._sending === true
  const sendError = m._sendError
  const readReceiptLine =
    isSelf && !isSending && !sendError
      ? readReceiptLineForMessage(props.readReceipts, m.id, props.myUserId)
      : null

  const richSpans = messageBodyRich(m)
  // Resolve which attachment the focus ring points at, but only for the
  // focused message — every other row leaves its links/images at the subtle
  // (unfocused) treatment. Index 0 is the body, so >0 selects an attachment.
  let focusedLinkHref: string | null = null
  let focusedImageKey: string | null = null
  let threadFocused = false
  if (props.focused && props.focusedAttachmentIndex && props.focusedAttachmentIndex > 0) {
    const fa = messageFocusables(m, props.threadMeta?.count)[props.focusedAttachmentIndex]
    if (fa?.kind === 'link') focusedLinkHref = fa.ref.href
    else if (fa?.kind === 'image') focusedImageKey = fa.ref.cacheKey
    else if (fa?.kind === 'thread') threadFocused = true
  }
  // Styled runs, split into link runs, with line breaks kept outside fs():
  // an OSC 66 sized-text sequence must not span a newline.
  const bodyRuns: { text: string; style: RichSpan; link?: BodySpan['kind'] }[] = []
  for (const span of richSpans) {
    for (const piece of span.text.split(/(\n)/)) {
      if (piece === '\n') bodyRuns.push({ text: '\n', style: { text: '' } })
      else
        for (const ls of splitBodyLinkSpans(piece, focusedLinkHref))
          bodyRuns.push({ text: ls.text, style: span, link: ls.kind })
    }
  }
  const isDeleted = isMessageDeleted(m)
  const isEdited = !isDeleted && isMessageEdited(m)
  const reactionLine = shouldShowReactionRow(
    { kind: 'message', key: m.id, message: m },
    { reactionDisplayMode: props.reactionDisplayMode, focusedMessageId: props.focusedMessageId },
  )
    ? reactionsSummary(m.reactions)
    : null

  // Status precedence: error first (red), then sending (gray dim), then
  // system / self colors.
  let color: string | undefined
  if (sendError) color = theme.errorText
  else if (isSending) color = theme.systemEvent
  else if (isSystem) color = theme.systemEvent
  else if (isSelf) color = theme.selfMessage ?? undefined
  else color = theme.senderMessage ?? undefined

  // The marker column carries the focus arrow when this row is focused;
  // otherwise the send-status glyph (failed / sending). It sits on the body
  // line (the thing being focused), not the sender header, and is as wide as
  // the body indent. The sender line has its own indent (layout.senderIndent).
  const sendStatusGlyph = sendError ? '✗' : isSending ? '…' : ' '
  const indicator = props.focused ? props.focusIndicatorChar.slice(0, 1) || '>' : sendStatusGlyph
  const indent = Math.max(0, props.bodyIndent)
  const markerWidth = Math.max(1, indent)
  const senderIndent = Math.max(0, theme.layout.senderIndent)
  const align = flip ? 'flex-end' : undefined

  // On the first text row, below any background padding / bubble frame.
  const markerTop =
    theme.layout.textBackgroundPaddingY + (theme.layout.textBackgroundRadius > 0 ? 1 : 0)
  const marker = (
    <Box width={markerWidth} flexShrink={0} paddingTop={markerTop}>
      {/* No background: the marker color stands on its own, and the focus
          background belongs to the focused message body. */}
      <Text color={props.focused ? theme.messageFocusIndicator : undefined}>{indicator}</Text>
    </Box>
  )

  // An indented content row (body, quoted reply, thread/receipt/error lines):
  // the indent spacer plus a grown content box, mirrored to the right in flip
  // mode so the whole block hugs the right edge.
  const contentRow = (key: string, node: ReactNode) => (
    <Box key={key} flexDirection="row">
      {!flip && indent > 0 && <Box width={indent} flexShrink={0} />}
      <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent={align}>
        {node}
      </Box>
      {flip && indent > 0 && <Box width={indent} flexShrink={0} />}
    </Box>
  )

  const bodyBg = props.focused
    ? (theme.messageFocusBackground ?? undefined)
    : isDeleted || isSystem
      ? undefined
      : ((isSelf ? theme.selfMessageBackground : theme.senderMessageBackground) ?? undefined)
  const bodyTextNode = (
    <Text
      color={
        isDeleted ? theme.mutedText : props.focused ? (theme.messageFocusText ?? color) : color
      }
      backgroundColor={bodyBg}
      italic={isDeleted}
      bold={props.focused && !isDeleted && theme.emphasis.focusedBold}
      wrap="wrap"
    >
      {bodyRuns.map((run, i) => {
        if (run.text === '\n') return <Text key={i}>{'\n'}</Text>
        const { style, link } = run
        // Unset flags stay undefined so the focused message's bold inherits.
        const styled = {
          bold: style.bold || undefined,
          italic: style.italic || undefined,
          underline: style.underline || undefined,
          strikethrough: style.strike || undefined,
          color: style.code ? theme.infoText : undefined,
        }
        if (link === 'text') {
          return (
            <Text key={i} {...styled}>
              {fs(run.text, theme.fontSize.messageText)}
            </Text>
          )
        }
        return (
          <Text
            key={i}
            {...styled}
            color={theme.selected}
            underline
            bold={link === 'link-focused' || styled.bold}
            backgroundColor={
              link === 'link-focused' ? (theme.selectedRowBackground ?? undefined) : undefined
            }
          >
            {fs(run.text, theme.fontSize.messageText)}
          </Text>
        )
      })}
      {isEdited && <Text color={theme.mutedText}> (edited)</Text>}
      {reactionLine && <Text color={theme.mutedText}> {`(${reactionLine})`}</Text>}
    </Text>
  )
  // Ink paints a Box background over its padding and the ragged ends of
  // wrapped lines, so the padded body reads as one solid block.
  const bgPadX = theme.layout.textBackgroundPaddingX
  const bgPadY = theme.layout.textBackgroundPaddingY
  // Rounded: a half-block frame in the background color around the padded
  // body, kept (blank) on bodies without one so focusing doesn't shift text.
  const rounded = theme.layout.textBackgroundRadius > 0
  const bodyNode =
    bgPadX > 0 || bgPadY > 0 || rounded ? (
      <Box
        paddingX={bgPadX}
        paddingY={bgPadY}
        backgroundColor={bodyBg}
        borderStyle={rounded ? (bodyBg ? BUBBLE_BORDER : BLANK_BUBBLE_BORDER) : undefined}
        borderColor={bodyBg}
      >
        {bodyTextNode}
      </Box>
    ) : (
      bodyTextNode
    )

  // System and deleted rows have no sender header — the marker line carries
  // their single line of text directly.
  const hasHeader = !isSystem && !isDeleted && (props.showTimestamp || senderName.length > 0)
  const timeText = senderName ? `  ${time}` : time
  // Quoted-reply preview (chat-pane only). Channel threads represent replies
  // via the existing thread tree; double-decorating both would be visual noise.
  const quotedReply = !isSystem ? getQuotedReply(m) : null

  const conversationWidth =
    theme.layout.messageMaxWidth < 100 ? `${theme.layout.messageMaxWidth}%` : undefined
  const bodyRow = (
    <Box flexDirection="row">
      {!flip && marker}
      <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent={align}>
        {bodyNode}
      </Box>
      {flip && marker}
    </Box>
  )
  const block = (
    <>
      {hasHeader ? (
        <Box flexDirection="row" height={props.tallHeader ? 2 : undefined}>
          {!flip && senderIndent > 0 && <Box width={senderIndent} flexShrink={0} />}
          <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent={align}>
            <Text wrap="truncate-end">
              <Text
                color={
                  isSelf && !sendError && !isSending ? theme.selfName : (color ?? theme.sender)
                }
                bold={senderName.length > 0 && theme.emphasis.senderBold}
              >
                {props.tallHeader
                  ? fsTall(senderName, theme.fontSize.sender)
                  : fs(senderName, theme.fontSize.sender, theme.fontSize.tightSpacing)}
              </Text>
              {props.showTimestamp && (
                <Text color={theme.timestamp}>
                  {props.tallHeader
                    ? fsTall(timeText, theme.fontSize.timestamp)
                    : fs(timeText, theme.fontSize.timestamp, theme.fontSize.tightSpacing)}
                </Text>
              )}
            </Text>
          </Box>
          {flip && senderIndent > 0 && <Box width={senderIndent} flexShrink={0} />}
        </Box>
      ) : null}
      {/* The message itself narrows to layout.messageMaxWidth, centered; the
          sender line above keeps the full width and its own sender indent. */}
      <Box
        flexDirection="column"
        flexShrink={0}
        width={conversationWidth}
        alignSelf={conversationWidth ? 'center' : undefined}
      >
        {!hasHeader && bodyRow}
        {quotedReply &&
          contentRow(
            'quoted',
            <Text color={theme.mutedText} wrap="truncate-end">
              {`↳ replying to ${quotedReply.senderName}${
                quotedReply.preview ? `: "${quotedReply.preview}"` : ''
              }`}
            </Text>,
          )}
        {hasHeader && bodyRow}
        {props.threadMeta &&
          props.threadMeta.count > 0 &&
          contentRow(
            'thread',
            <Text wrap="truncate-end">
              <Text color={theme.mutedText}>╰─ </Text>
              <Text
                color={threadFocused ? theme.selected : theme.mutedText}
                bold={threadFocused}
                backgroundColor={
                  threadFocused ? (theme.selectedRowBackground ?? undefined) : undefined
                }
              >
                {formatReplyCount(props.threadMeta)}
              </Text>
            </Text>,
          )}
        {readReceiptLine &&
          contentRow(
            'receipt',
            <Text color={theme.mutedText} wrap="truncate-end">
              {readReceiptLine}
            </Text>,
          )}
        {sendError &&
          contentRow(
            'error',
            <Text color={theme.warnText} wrap="truncate-end">
              {`send failed: ${sendError.slice(0, 120)}`}
            </Text>,
          )}
        {/* Images share the left body indent, including in flip mode. */}
        {!isDeleted &&
          extractInlineImages(m).map((ref: InlineImageRef) => (
            <ImageRows
              key={ref.cacheKey}
              cacheKey={ref.cacheKey}
              imgCols={props.imgCols}
              maxRows={props.inlineImageMaxRows}
              painted={props.inlineImagesPainted}
              label={ref.name}
              focused={focusedImageKey === ref.cacheKey}
              bodyIndent={indent}
              theme={theme}
            />
          ))}
        {!isDeleted &&
          extractFileAttachments(m).map((file) => (
            <FileAttachmentRow
              key={`file-${file.id}`}
              label={file.name}
              sizeText={formatBytes(file.sizeBytes)}
              flip={flip}
              bodyIndent={indent}
              theme={theme}
            />
          ))}
      </Box>
      {Array.from({ length: Math.max(0, props.messageGap) }, (_, i) => (
        <Box key={`gap-${i}`}>
          <Text> </Text>
        </Box>
      ))}
    </>
  )
  // Profile pictures: a column left of the message, the picture at the top of
  // a sender's run. Every non-flipped message keeps the column so bodies
  // line up; flipped own messages (right-aligned) have none.
  const avatar = props.avatar
  if (!avatar || flip) return block
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box width={avatar.column} flexShrink={0} flexDirection="column">
        {avatar.userId && (
          <PictureSlot
            slots={slots}
            cacheKey={userPhotoKey(avatar.userId, avatarPixels(avatar.rows))}
            rows={avatar.rows}
            cols={avatar.cols}
            label={initialsOf(senderRaw)}
            fallbackKey={initialsKey(initialsOf(senderRaw))}
            theme={theme}
          />
        )}
      </Box>
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        minHeight={avatar.userId ? avatar.rows : undefined}
      >
        {block}
      </Box>
    </Box>
  )
}

function FileAttachmentRow(props: {
  label: string
  sizeText: string
  flip?: boolean
  bodyIndent: number
  theme: Theme
}) {
  const suffix = props.sizeText ? ` (${props.sizeText})` : ''
  const indent = Math.max(0, props.bodyIndent)
  return (
    <Box flexDirection="row">
      {!props.flip && indent > 0 && <Box width={indent} flexShrink={0} />}
      <Box
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        justifyContent={props.flip ? 'flex-end' : undefined}
      >
        <Text color={props.theme.mutedText} wrap="truncate-end">
          {`📎 ${props.label}${suffix}`}
        </Text>
      </Box>
      {props.flip && indent > 0 && <Box width={indent} flexShrink={0} />}
    </Box>
  )
}

// Reserves vertical space for one inline image. Until the image loads it
// shows a single `[img] name` label row; once loaded it reserves exactly the
// image's fitted height (no label) and the Kitty layer paints the picture
// into those rows. Keeping the reserved height equal to the fitted height is
// what stops the old fixed-max padding and the overlay/offset.
function ImageRows(props: {
  cacheKey: string
  imgCols: number
  maxRows: number
  /** Whether the Kitty layer actually paints pictures in this mode/terminal. */
  painted: boolean
  label: string
  focused?: boolean
  bodyIndent: number
  theme: Theme
}) {
  const slots = useContext(ImageSlotsContext)
  const accountId = useAppState((s) => s.account?.id)
  const indent = Math.max(0, props.bodyIndent)
  // A bar marks the image's vertical extent in lieu of a full box border: the
  // picture is painted out-of-band by the Kitty layer into rows whose
  // count/offset is computed precisely elsewhere, so wrapping it in a bordered
  // Box (which adds rows/columns) would desync that placement. The bar sits
  // just left of the image, occupying the last indent column; it is subtle for
  // every image and strong (heavy + highlighted) for the focused one.
  const lead = indent > 1 ? <Box width={indent - 1} flexShrink={0} /> : null
  const gutter = (
    <Box width={1} flexShrink={0}>
      <Text
        color={props.focused ? props.theme.selected : props.theme.border}
        bold={props.focused}
        backgroundColor={
          props.focused ? (props.theme.selectedRowBackground ?? undefined) : undefined
        }
      >
        {props.focused ? '┃' : '│'}
      </Text>
    </Box>
  )
  const reservedRows = inlineImageReservedRows(
    accountId,
    props.cacheKey,
    props.imgCols,
    props.maxRows,
    props.painted,
  )
  if (reservedRows === null) {
    // Label placeholder ([img] name) for a still-loading or non-paintable
    // image. When focused, the whole label is highlighted to match the bar —
    // not just the bar itself.
    return (
      <Box flexDirection="row">
        {lead}
        {gutter}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text
            color={props.focused ? props.theme.selected : props.theme.mutedText}
            bold={props.focused}
            backgroundColor={
              props.focused ? (props.theme.selectedRowBackground ?? undefined) : undefined
            }
            wrap="truncate-end"
          >
            {inlineImagePlaceholder(accountId, props.cacheKey, props.label)}
          </Text>
        </Box>
      </Box>
    )
  }
  return (
    <Box
      flexDirection="column"
      height={reservedRows}
      flexShrink={0}
      ref={(node) => {
        if (!node) return
        slots.set(node, {
          cacheKey: props.cacheKey,
          rows: reservedRows,
          inset: Math.max(1, indent),
        })
        return () => {
          slots.delete(node)
        }
      }}
    >
      {Array.from({ length: reservedRows }, (_, i) => (
        <Box key={`img-space-${i}`} flexDirection="row">
          {lead}
          {gutter}
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text> </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function messageBodyTerminalColumn(opts: { bodyIndent: number; listPaneWidth: number }) {
  // Pane content begins after the chat-list pane + its 2-column border; the
  // body (and the inline-image painting that aligns with it) is indented from
  // there by the configured amount.
  return opts.listPaneWidth + 2 + opts.bodyIndent
}

// Fitted picture rows for a loaded inline image, or null when it hasn't
// loaded yet (the caller renders the [img] label instead). Shared by the
// height math, the reserved blank rows, and the Kitty placement so all three
// agree on how many rows each image occupies.
function inlineImageReservedRows(
  accountId: AccountId | undefined,
  cacheKey: string,
  imgCols: number,
  maxRows: number,
  painted: boolean,
): number | null {
  // Nothing is painted when inline images are off, or in a terminal without
  // the Kitty graphics protocol. Reserving blank rows then leaves a phantom
  // gap where no picture ever arrives — the row renders its `[img]` link
  // label instead, and Space opens it in the image modal. One gate for the
  // height math, the reserved rows, and the paint effect so they can't
  // disagree.
  if (!painted) return null
  const data = getImageData(accountId, cacheKey)
  if (!data) return null
  // Only PNG can actually be painted by the Kitty layer. Returning null for
  // anything else makes the row render its labeled placeholder instead of
  // reserving blank space the picture will never fill.
  if (!isKittyRenderable(data)) return null
  return fitKittyPlacement(data, imgCols, maxRows).reservedRows
}

// Placeholder text for an image we can't paint: still loading, or a format
// (JPEG/GIF/WebP) Kitty terminals can't decode. Noting the format makes
// "why isn't my image showing" answerable at a glance.
function inlineImagePlaceholder(
  accountId: AccountId | undefined,
  cacheKey: string,
  name: string,
): string {
  const data = getImageData(accountId, cacheKey)
  const fmt = data ? detectImageFormat(data) : null
  if (fmt && fmt !== 'png') return `[img] ${name} (${fmt})`
  return `[img] ${name}`
}

// Locally-derived reply-count badge for a channel root message. `count` is
// the number of replies present in the loaded stream; `more` is reserved for
// a future window-gap signal (see the rootMessageId rebuild plan, step 3) and
// is false for now — the badge reflects what's loaded.
export type ReplyBadge = { count: number; more: boolean }

function replyBadgeFor(threads: ChannelThreads, rootId: string): ReplyBadge | undefined {
  const count = replyCountForRoot(threads, rootId)
  return count > 0 ? { count, more: false } : undefined
}

export function formatReplyCount(meta: ReplyBadge): string {
  if (meta.count <= 0) return ''
  const suffix = meta.count === 1 ? 'reply' : 'replies'
  return meta.more ? `${meta.count}+ ${suffix}` : `${meta.count} ${suffix}`
}

export function readReceiptLineForMessage(
  receipts: Record<string, ReadReceipt> | undefined,
  messageId: string,
  myUserId?: string,
): string | null {
  if (!receipts) return null
  const seenCount = Object.values(receipts).filter(
    (r) => r.messageId === messageId && r.userId !== myUserId,
  ).length
  if (seenCount <= 0) return null
  return seenCount === 1 ? 'seen by 1' : `seen by ${seenCount}`
}

function TypingLine(props: { typing: TypingIndicator[]; theme: Theme }) {
  if (props.typing.length === 0) return null
  const names = props.typing.map((t) => shortName(t.displayName))
  const text =
    names.length === 1
      ? `${names[0]} is typing${TYPING_DOT}`
      : `${names.join(', ')} are typing${TYPING_DOT}`
  return (
    <Box>
      <Box width={1} flexShrink={0} />
      <Text color={props.theme.mutedText} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
}

function headerForFocus(
  focus:
    | { kind: 'chat'; chatId: string }
    | { kind: 'channel'; teamId: string; channelId: string }
    | { kind: 'thread'; teamId: string; channelId: string; rootId: string },
  chats: Chat[],
  teams: Team[],
  channelsByTeam: Record<string, Channel[]>,
  myUserId?: string,
  nameByUserId?: Record<string, string>,
): string {
  if (focus.kind === 'chat') {
    const chat = chats.find((c) => c.id === focus.chatId)
    if (!chat) return `chat ${focus.chatId.slice(0, 16)}...`
    return chatLabel(chat, myUserId, { nameByUserId })
  }
  const team = teams.find((t) => t.id === focus.teamId)
  const channel = (channelsByTeam[focus.teamId] ?? []).find((c) => c.id === focus.channelId)
  const teamName = team?.displayName ?? '?'
  const channelName = channel?.displayName ?? '?'
  if (focus.kind === 'thread') {
    return `${teamName} · # ${channelName} · thread`
  }
  return `${teamName} · # ${channelName}`
}
