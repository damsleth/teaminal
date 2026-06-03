// Center pane: message timeline.
//
// Renders messages in chronological order (poller already reverses Graph's
// descending API result). System messages (messageType=systemEventMessage)
// are styled gray and labeled. Self messages get a subtle color cue.
// HTML bodies are converted via src/ui/html.htmlToText so <at>, <emoji>,
// <a>, and entity refs render correctly.

import { Box, Text, useStdout } from 'ink'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { chatLabel, shortName } from '../state/selectables'
import { focusKey, type ReadReceipt, type TypingIndicator } from '../state/store'
import {
  groupChannelThreads,
  replyCountForRoot,
  type ChannelThreads,
} from '../state/channelThreads'
import type { Chat, ChatMessage, Channel, Team } from '../types'
import { htmlToText } from '../text/html'
import { extractFileAttachments, formatBytes } from '../text/fileAttachments'
import { extractInlineImages, type InlineImageRef } from '../text/inlineImages'
import { reactionsSummary } from './reactions'
import { describeSystemEvent } from './systemEvent'
import { searchMessages } from './messageSearch'
import {
  effectiveSenderName,
  getQuotedReply,
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
import { useAppState, useTheme } from './StoreContext'
import {
  isKittyCapable,
  isKittyRenderable,
  detectImageFormat,
  buildKittyAPC,
  clearKittyImages,
  fitKittyPlacement,
  writeKittyImageAtOffset,
} from './kittyGraphics'
import { ensureImageFetched, getImageData } from '../state/imageCache'
import { getActiveProfile } from '../graph/client'
import { messageFocusables } from './messageFocusables'
import { splitBodyLinkSpans } from './bodySpans'
import { pickerAnchorCol } from './pickerAnchor'

export { effectiveSenderName, isRenderableMessage } from './renderableMessage'

const TYPING_DOT = '…'

// Reserve for surrounding chrome so the message pane doesn't overflow the
// terminal. Header bar (3) + composer box (3) + status bar (1) + pane
// border (2) + safety pad (1) = 10. Cozy density adds an in-pane header
// row plus a spacer below it (2), the loading-older indicator (when
// present) is one extra line, and the typing indicator (when present)
// is another.
const CHROME_RESERVED_ROWS = 10
const COZY_HEADER_ROWS = 2
const MIN_VISIBLE_ROWS = 5
// Fallback for LIST_PANE_WIDTH when no prop is provided. Kept to avoid
// breaking isolated renders; App.tsx always passes the resolved width.
const LIST_PANE_WIDTH_DEFAULT = 30

export function MessagePane(props: {
  focusedMessageId?: string | null
  focusIndicatorActive?: boolean
  loadOlderState?: LoadMoreState
  /** Resolved chat-list pane width, used for Kitty cursor placement. */
  listPaneWidth?: number
}) {
  const focus = useAppState((s) => s.focus)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const messageCacheByConvo = useAppState((s) => s.messageCacheByConvo)
  const me = useAppState((s) => s.me)
  const nameByUserId = useAppState((s) => s.nameByUserId)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const showTimestamps = useAppState((s) => s.settings.showTimestampsInPane)
  const shortNames = useAppState((s) => s.settings.messagePaneShortNames)
  const density = useAppState((s) => s.settings.chatListDensity)
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
  // top): the Kitty image offset and the row budget both anchor to the bottom
  // chrome, so 'top' frees the same row that 'hidden' does.
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

  const listPaneWidth = props.listPaneWidth ?? LIST_PANE_WIDTH_DEFAULT

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
  const messageGap = theme.layout.paneHeaderMarginBottom
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
  const cozyRows = density === 'cozy' ? COZY_HEADER_ROWS : 0
  const typingActive = (typingByConvo[conv] ?? []).length > 0
  const reservedDynamic = (isLoadingOlder ? 1 : 0) + (typingActive ? 1 : 0)
  const chromeRows = CHROME_RESERVED_ROWS - (statusBarHidden ? 1 : 0)
  const rowBudget = Math.max(
    MIN_VISIBLE_ROWS,
    terminalSize.rows - chromeRows - cozyRows - reservedDynamic,
  )
  // Body wrap width estimate for the viewport budget: pane content (terminal
  // minus the chat-list pane and its border) minus the body indent. Bodies now
  // start near the left edge instead of after a deep sender column.
  const messageTextColumns = Math.max(12, terminalSize.columns - listPaneWidth - 2 - bodyIndent)
  // Cell budget for an inline image (message pane minus the gutter columns).
  const imgCols = Math.max(12, terminalSize.columns - listPaneWidth - 20)
  // Rows a message's inline images occupy: each loaded image takes its fitted
  // height (no label), each still-loading image takes one `[img]` label row.
  // Recomputed each render (imageRevision bumps on load) so layout, the
  // reserved blank rows, and the Kitty placement all agree.
  const imageRowsForMessage = (message: ChatMessage): number =>
    extractInlineImages(message).reduce((sum, ref) => {
      const reserved = inlineImageReservedRows(ref.cacheKey, imgCols, inlineImageMaxRows)
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

  // Trigger image fetches for visible messages and write Kitty sequences
  // for the focused message after each render. The imageRevision counter
  // is bumped by ensureImageFetched's onChange callback so the component
  // re-renders once an image transitions from loading → ready.
  useEffect(() => {
    if (!kittyEnabled) return
    // While a modal overlay covers the pane, clear any drawn images and skip
    // re-drawing so the overlay is not painted over by out-of-band Kitty
    // graphics. They redraw on the next render once the modal closes.
    if (modalOpen) {
      if (stdout) clearKittyImages(stdout)
      return
    }
    const profile = getActiveProfile()

    for (const row of rows) {
      if (row.kind !== 'message') continue
      const m = row.message
      const refs = extractInlineImages(m)
      for (const ref of refs) {
        ensureImageFetched(
          ref.sourcePath,
          ref.cacheKey,
          { contentType: ref.contentType, name: ref.name },
          {
            profile,
            isExternal: ref.isExternal,
            ...(ref.objectId ? { objectId: ref.objectId } : {}),
            ...(ref.region ? { region: ref.region } : {}),
            onChange: () => setImageRevision((r) => r + 1),
          },
        )
      }
    }

    if (!stdout) return

    const rowsAfter = new Array(rows.length).fill(0) as number[]
    let below = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      rowsAfter[i] = below
      below += messageRenderRowHeight(rows[i]!, {
        imageRowsForMessage,
        messageTextColumns,
        messageGap,
        reactionDisplayMode,
      })
    }

    clearKittyImages(stdout)
    const imageColumn = messageBodyTerminalColumn({ bodyIndent, listPaneWidth })
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!
      if (row.kind !== 'message') continue
      const refs = extractInlineImages(row.message)
      // Per-image fitted rows (null = not yet loaded → renders a label row).
      const reserved = refs.map((ref) =>
        inlineImageReservedRows(ref.cacheKey, imgCols, inlineImageMaxRows),
      )
      const fileRows = extractFileAttachments(row.message).length
      for (let imageIndex = 0; imageIndex < refs.length; imageIndex++) {
        const ref = refs[imageIndex]!
        const reservedRows = reserved[imageIndex]
        if (reservedRows === null || reservedRows === undefined) continue
        const imgData = getImageData(ref.cacheKey)
        if (!imgData) continue
        const placement = fitKittyPlacement(imgData, imgCols, inlineImageMaxRows)
        const apc = buildKittyAPC(imgData, placement)
        // Rows below this image's top, within its own message: the rest of
        // this image, then later images' blocks (fitted rows or a label
        // row each), then file-attachment rows, then the trailing group gap.
        let belowWithinMessage = reservedRows - 1
        for (let j = imageIndex + 1; j < refs.length; j++) {
          const r = reserved[j]
          belowWithinMessage += r === null || r === undefined ? 1 : r
        }
        belowWithinMessage += fileRows + messageGap
        const rowsFromBottom =
          rowsAfter[rowIndex]! + belowWithinMessage + bottomChromeRows(statusBarHidden) + 1
        writeKittyImageAtOffset(stdout, apc, rowsFromBottom, reservedRows, imageColumn)
      }
    }

    return () => {
      clearKittyImages(stdout)
    }
  })

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
    const heightOpts = { imageRowsForMessage, messageTextColumns, messageGap, reactionDisplayMode }
    let rowsBefore = 0
    for (let i = 0; i < idx; i++) rowsBefore += messageRenderRowHeight(rows[i]!, heightOpts)
    // Chrome above the pane content: header bar (3) + message-pane top border
    // (1); pane content then starts on the next row. Add the in-pane prelude
    // (cozy header, search bar, loading-older line) that pushes messages down,
    // plus the focused message's own sender-header line so the anchor lands on
    // the body rather than the name.
    const preludeRows =
      cozyRows + (searchActive ? 1 : 0) + (isLoadingOlder && !showingHistoryTop ? 1 : 0)
    const row = 4 + 1 + preludeRows + rowsBefore + 1
    // Compute the column at the end of the focused message body's last wrapped
    // line. `messageBodyTerminalColumn` gives the 1-based terminal column where
    // the body text begins; `pickerAnchorCol` adds the display width of the
    // last wrapped line so the picker anchors to the trailing edge.
    const focusedRow = rows[idx]
    const focusedMsg = focusedRow?.kind === 'message' ? focusedRow.message : null
    const bodyText = focusedMsg ? previewBody(focusedMsg) : ''
    const bodyStartCol = messageBodyTerminalColumn({ bodyIndent, listPaneWidth })
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
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      overflow="hidden"
      paddingX={0}
    >
      {density === 'cozy' && (
        <Box paddingLeft={bodyIndent} marginBottom={1} flexShrink={0}>
          <Text bold={theme.emphasis.sectionHeadingBold}>{headerLabel}</Text>
        </Box>
      )}
      {searchActive && (
        <Box>
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
        <Text color={theme.mutedText}>… loading older messages</Text>
      )}
      <Box flexDirection="column">
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
                selfMessagesOnRight={selfMessagesOnRight}
                bodyIndent={bodyIndent}
                messageGap={messageGap}
                shortNames={shortNames}
                showTimestamp={showTimestamps}
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
  )
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
  selfMessagesOnRight: boolean
  bodyIndent: number
  messageGap: number
  shortNames: boolean
  showTimestamp: boolean
  theme: Theme
  threadMeta?: ReplyBadge
}) {
  if (props.row.kind === 'date') {
    return (
      <Box>
        {props.showTimestamp && <Box width={1} flexShrink={0} />}
        <Text color="gray" bold>
          {props.row.label}
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
      selfMessagesOnRight={props.selfMessagesOnRight}
      bodyIndent={props.bodyIndent}
      messageGap={props.messageGap}
      shortNames={props.shortNames}
      showTimestamp={props.showTimestamp}
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
  selfMessagesOnRight: boolean
  bodyIndent: number
  messageGap: number
  shortNames: boolean
  showTimestamp: boolean
  theme: Theme
  threadMeta?: ReplyBadge
}) {
  const { theme } = props
  const m = props.message
  const isSelf = !!props.myUserId && m.from?.user?.id === props.myUserId
  const flip = props.selfMessagesOnRight && isSelf
  const time = m.createdDateTime.slice(11, 16)
  const isSystem = m.messageType === 'systemEventMessage'
  // The sender name now gets its own line above the body, so it is shown in
  // full (the header line truncates only if it overruns the pane). System
  // rows have no sender; their text occupies the single line.
  const senderRaw = isSystem ? '' : (effectiveSenderName(m) ?? '')
  const senderName = senderRaw ? (props.shortNames ? shortName(senderRaw) : senderRaw) : ''
  const isSending = m._sending === true
  const sendError = m._sendError
  const readReceiptLine =
    isSelf && !isSending && !sendError
      ? readReceiptLineForMessage(props.readReceipts, m.id, props.myUserId)
      : null

  const bodyText = previewBody(m)
  // Resolve which attachment the focus ring points at, but only for the
  // focused message — every other row leaves its links/images at the subtle
  // (unfocused) treatment. Index 0 is the body, so >0 selects an attachment.
  let focusedLinkHref: string | null = null
  let focusedImageKey: string | null = null
  if (props.focused && props.focusedAttachmentIndex && props.focusedAttachmentIndex > 0) {
    const fa = messageFocusables(m)[props.focusedAttachmentIndex]
    if (fa?.kind === 'link') focusedLinkHref = fa.ref.href
    else if (fa?.kind === 'image') focusedImageKey = fa.ref.cacheKey
  }
  const bodySpans = splitBodyLinkSpans(bodyText, focusedLinkHref)
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
  else if (isSelf) color = theme.selfMessage

  // The marker column carries the focus arrow when this row is focused;
  // otherwise the send-status glyph (failed / sending). It is as wide as the
  // body indent so the sender name lines up directly above the body.
  const sendStatusGlyph = sendError ? '✗' : isSending ? '…' : ' '
  const indicator = props.focused ? props.focusIndicatorChar.slice(0, 1) || '>' : sendStatusGlyph
  const indent = Math.max(0, props.bodyIndent)
  const markerWidth = Math.max(1, indent)
  const align = flip ? 'flex-end' : undefined

  const marker = (
    <Box width={markerWidth} flexShrink={0}>
      <Text
        color={props.focused ? theme.messageFocusIndicator : undefined}
        backgroundColor={props.focused ? (theme.messageFocusBackground ?? undefined) : undefined}
      >
        {indicator}
      </Text>
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

  const bodyNode = (
    <Text
      color={isDeleted ? theme.mutedText : props.focused ? theme.messageFocusIndicator : color}
      italic={isDeleted}
      bold={props.focused && !isDeleted}
      wrap="wrap"
    >
      {bodySpans.map((span, i) =>
        span.kind === 'text' ? (
          <Text key={i}>{span.text}</Text>
        ) : (
          <Text
            key={i}
            color={theme.selected}
            underline
            bold={span.kind === 'link-focused'}
            backgroundColor={
              span.kind === 'link-focused' ? (theme.selectedRowBackground ?? undefined) : undefined
            }
          >
            {span.text}
          </Text>
        ),
      )}
      {isEdited && <Text color={theme.mutedText}> (edited)</Text>}
      {reactionLine && <Text color={theme.mutedText}> {`(${reactionLine})`}</Text>}
    </Text>
  )

  // System and deleted rows have no sender header — the marker line carries
  // their single line of text directly.
  const hasHeader = !isSystem && !isDeleted
  // Quoted-reply preview (chat-pane only). Channel threads represent replies
  // via the existing thread tree; double-decorating both would be visual noise.
  const quotedReply = !isSystem ? getQuotedReply(m) : null

  return (
    <>
      {hasHeader ? (
        <Box flexDirection="row">
          {!flip && marker}
          <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent={align}>
            <Text wrap="truncate-end">
              <Text color={color} bold={senderName.length > 0 && theme.emphasis.senderBold}>
                {senderName}
              </Text>
              {props.showTimestamp && <Text color={theme.timestamp}>{`  ${time}`}</Text>}
            </Text>
          </Box>
          {flip && marker}
        </Box>
      ) : (
        <Box flexDirection="row">
          {!flip && marker}
          <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent={align}>
            {bodyNode}
          </Box>
          {flip && marker}
        </Box>
      )}
      {quotedReply &&
        contentRow(
          'quoted',
          <Text color={theme.mutedText} wrap="truncate-end">
            {`↳ replying to ${quotedReply.senderName}${
              quotedReply.preview ? `: "${quotedReply.preview}"` : ''
            }`}
          </Text>,
        )}
      {hasHeader && contentRow('body', bodyNode)}
      {props.threadMeta &&
        props.threadMeta.count > 0 &&
        contentRow(
          'thread',
          <Text color={theme.mutedText} wrap="truncate-end">
            {`╰─ ${formatReplyCount(props.threadMeta)}`}
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
      {/* Inline images are not mirrored in flip mode: the picture is painted
          out-of-band by the Kitty layer at a fixed column derived from the left
          edge (messageBodyTerminalColumn), so flipping only the reserved rows
          would desync the painting from its label. They share the body indent. */}
      {!isDeleted &&
        extractInlineImages(m).map((ref: InlineImageRef) => (
          <ImageRows
            key={ref.cacheKey}
            cacheKey={ref.cacheKey}
            imgCols={props.imgCols}
            maxRows={props.inlineImageMaxRows}
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
      {Array.from({ length: Math.max(0, props.messageGap) }, (_, i) => (
        <Box key={`gap-${i}`}>
          <Text> </Text>
        </Box>
      ))}
    </>
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
  label: string
  focused?: boolean
  bodyIndent: number
  theme: Theme
}) {
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
  const reservedRows = inlineImageReservedRows(props.cacheKey, props.imgCols, props.maxRows)
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
            {inlineImagePlaceholder(props.cacheKey, props.label)}
          </Text>
        </Box>
      </Box>
    )
  }
  return (
    <>
      {Array.from({ length: reservedRows }, (_, i) => (
        <Box key={`img-space-${i}`} flexDirection="row">
          {lead}
          {gutter}
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text> </Text>
          </Box>
        </Box>
      ))}
    </>
  )
}

function bottomChromeRows(statusBarHidden: boolean): number {
  // Composer (2) + status bar (1) + safety pad (1). Subtracts 1 when
  // the status bar is hidden so images anchor one row lower.
  return 4 - (statusBarHidden ? 1 : 0)
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
  cacheKey: string,
  imgCols: number,
  maxRows: number,
): number | null {
  const data = getImageData(cacheKey)
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
function inlineImagePlaceholder(cacheKey: string, name: string): string {
  const data = getImageData(cacheKey)
  const fmt = data ? detectImageFormat(data) : null
  if (fmt && fmt !== 'png') return `[img] ${name} (${fmt})`
  return `[img] ${name}`
}

function previewBody(m: ChatMessage): string {
  if (isMessageDeleted(m)) {
    const senderName = m.from?.user?.displayName ?? 'someone'
    const time = m.createdDateTime.slice(11, 16)
    return `(message deleted by ${senderName} · ${time})`
  }
  if (m.messageType === 'systemEventMessage') {
    const decoded = describeSystemEvent(m)
    return decoded ?? ''
  }
  const raw = m.body.content ?? ''
  if (m.body.contentType === 'text') {
    return raw.replace(/\s+/g, ' ').trim()
  }
  // Graph inserts an opaque <attachment id="..."></attachment> tag at
  // the top of body.content for quoted replies. htmlToText drops it
  // (unknown tag) but leaves the preceding whitespace; trim again so
  // the new message body starts at column 0.
  return htmlToText(raw).trim()
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

// 5s grace window: Graph rewrites lastModifiedDateTime as part of
// server-side normalization on a fresh send, so 'edited within 5s'
// is treated as 'not actually edited by the user'.
const EDITED_GRACE_MS = 5_000

export function isMessageEdited(m: ChatMessage): boolean {
  if (!m.lastModifiedDateTime) return false
  const created = Date.parse(m.createdDateTime)
  const modified = Date.parse(m.lastModifiedDateTime)
  if (!Number.isFinite(created) || !Number.isFinite(modified)) return false
  return modified - created > EDITED_GRACE_MS
}

export function isMessageDeleted(m: ChatMessage): boolean {
  if (m.deletedDateTime) return true
  // Some channel paths return a stub with empty body and no deletedDateTime.
  // We don't auto-detect those because empty bodies are also a legitimate
  // shape for system events; rely on the explicit deletedDateTime field.
  return false
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
