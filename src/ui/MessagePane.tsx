// Center pane: message timeline.
//
// Renders messages in chronological order (poller already reverses Graph's
// descending API result). System messages (messageType=systemEventMessage)
// are styled gray and labeled. Self messages get a subtle color cue.
// HTML bodies are converted via src/ui/html.htmlToText so <at>, <emoji>,
// <a>, and entity refs render correctly.

import { Box, Text, useStdout } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { chatLabel, shortName } from '../state/selectables'
import { focusKey, type ReadReceipt, type ThreadMeta, type TypingIndicator } from '../state/store'
import type { Chat, ChatMessage, Channel, Team } from '../types'
import { htmlToText } from './html'
import { reactionsSummary } from './reactions'
import { describeSystemEvent } from './systemEvent'
import { searchMessages } from './messageSearch'
import { effectiveSenderName, isRenderableMessage } from './renderableMessage'
import {
  buildMessageRows,
  chooseMessageRowsWindowStart,
  messageRowsWindowEnd,
  readMessagePageState,
  shouldShowReactionRow,
  type LoadMoreState,
  type MessageRenderRow,
} from './messageRows'
import type { Theme } from './theme'
import { useAppState, useTheme } from './StoreContext'

export { effectiveSenderName, isRenderableMessage } from './renderableMessage'

const TYPING_DOT = '…'

// Reserve for surrounding chrome so the message pane doesn't overflow the
// terminal. Header bar (3) + composer box (3) + status bar (1) + pane
// border (2) + safety pad (1) = 10. Cozy density adds an in-pane header
// row, the loading-older indicator (when present) is one extra line, and
// the typing indicator (when present) is another.
const CHROME_RESERVED_ROWS = 10
const MIN_VISIBLE_ROWS = 5
// Sender column width is computed per render from the longest first
// name in the conversation, so short-name conversations stay tight and
// long-name conversations don't truncate. Capped on both ends:
//   - SENDER_COL_MIN keeps the column readable even for empty / system
//     rows.
//   - SENDER_COL_MAX prevents a single long-handle outlier (e.g. an
//     external bot account) from pushing every body row absurdly right.
const SENDER_COL_MIN = 4
const SENDER_COL_MAX = 16

export function MessagePane(props: {
  focusedMessageId?: string | null
  focusIndicatorActive?: boolean
  loadOlderState?: LoadMoreState
}) {
  const focus = useAppState((s) => s.focus)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const messageCacheByConvo = useAppState((s) => s.messageCacheByConvo)
  const me = useAppState((s) => s.me)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const showTimestamps = useAppState((s) => s.settings.showTimestampsInPane)
  const density = useAppState((s) => s.settings.chatListDensity)
  const reactionDisplayMode = useAppState((s) => s.settings.showReactions)
  const inputZone = useAppState((s) => s.inputZone)
  const searchQuery = useAppState((s) => s.messageSearchQuery)
  const focusIndicatorVisible = useAppState((s) => s.settings.messageFocusIndicatorEnabled)
  const focusIndicatorChar = useAppState((s) => s.settings.messageFocusIndicatorChar)
  const typingByConvo = useAppState((s) => s.typingByConvo)
  const readReceiptsByConvo = useAppState((s) => s.readReceiptsByConvo)
  const threadMetaByRoot = useAppState((s) => s.threadMetaByRoot)
  const theme = useTheme()

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

  if (focus.kind === 'list') {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={0}>
        <Text color="gray">Select a chat or channel · Enter to open · q to quit</Text>
      </Box>
    )
  }

  const conv = focusKey(focus)!
  const rawMessages = messagesByConvo[conv] ?? []
  // Drop system-event rows we can't render usefully. This covers two
  // shapes Graph returns:
  //   1. messageType === 'systemEventMessage' with eventDetail we
  //      couldn't decode (or no eventDetail at all)
  //   2. messageType undefined / 'message' but with no sender and no
  //      body content - same outcome on the wire, blank "(system)" row.
  // In either case we'd rather show nothing than a meaningless line.
  const messages = rawMessages.filter((m) => isRenderableMessage(m))
  const senderColWidth = computeSenderColWidth(messages)
  const cache = messageCacheByConvo[conv]
  const headerLabel = headerForFocus(focus, chats, teams, channelsByTeam, me?.id)
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
  const cozyRows = density === 'cozy' ? 1 : 0
  const typingActive = (typingByConvo[conv] ?? []).length > 0
  const reservedDynamic = (isLoadingOlder ? 1 : 0) + (typingActive ? 1 : 0)
  const rowBudget = Math.max(
    MIN_VISIBLE_ROWS,
    terminalSize.rows - CHROME_RESERVED_ROWS - cozyRows - reservedDynamic,
  )
  const messageTextColumns = Math.max(12, terminalSize.columns - 60)
  const allRows = buildMessageRows(messages, {
    showLoadMoreRow: messages.length > 0 && !pageState.fullyLoaded,
    loadMoreState,
  })
  const windowStart = chooseMessageRowsWindowStart(allRows, {
    focusedMessageId: props.focusedMessageId,
    focusActive: props.focusIndicatorActive === true,
    messageTextColumns,
    reactionDisplayMode,
    rowBudget,
    previousStart: windowStartRef.current,
  })
  windowStartRef.current = windowStart
  const windowEnd = messageRowsWindowEnd(allRows, windowStart, {
    focusedMessageId: props.focusedMessageId,
    messageTextColumns,
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

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={0}>
      {density === 'cozy' && <Text bold>{headerLabel}</Text>}
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
                myUserId={me?.id}
                reactionDisplayMode={reactionDisplayMode}
                readReceipts={readReceiptsByConvo[conv]}
                senderColWidth={senderColWidth}
                showTimestamp={showTimestamps}
                theme={theme}
                threadMeta={
                  focus.kind === 'channel' && row.kind === 'message'
                    ? threadMetaByRoot[row.message.id]
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
  myUserId?: string
  reactionDisplayMode: 'off' | 'current' | 'all'
  readReceipts?: Record<string, ReadReceipt>
  senderColWidth: number
  showTimestamp: boolean
  theme: Theme
  threadMeta?: ThreadMeta
}) {
  if (props.row.kind === 'date') {
    return (
      <Box>
        <Box width={2} flexShrink={0} />
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
        <Box width={2} flexShrink={0} />
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
      myUserId={props.myUserId}
      reactionDisplayMode={props.reactionDisplayMode}
      readReceipts={props.readReceipts}
      senderColWidth={props.senderColWidth}
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
  myUserId?: string
  reactionDisplayMode: 'off' | 'current' | 'all'
  readReceipts?: Record<string, ReadReceipt>
  senderColWidth: number
  showTimestamp: boolean
  theme: Theme
  threadMeta?: ThreadMeta
}) {
  const { theme, senderColWidth } = props
  const m = props.message
  const time = m.createdDateTime.slice(11, 16)
  const isSystem = m.messageType === 'systemEventMessage'
  // Sender label resolution: system rows leave the sender column blank
  // and put the decoded subtype in the body. Other rows fall through to
  // the best available display name from from.user/application/device;
  // upstream filter guarantees non-null for non-system rows.
  const senderRaw = isSystem ? '' : (effectiveSenderName(m) ?? '')
  const senderShort = senderRaw ? shortName(senderRaw) : ''
  const senderTrimmed =
    senderShort.length > senderColWidth
      ? senderShort.slice(0, senderColWidth - 1) + '…'
      : senderShort
  const isSelf = !!props.myUserId && m.from?.user?.id === props.myUserId
  const isSending = m._sending === true
  const sendError = m._sendError
  const readReceiptLine =
    isSelf && !isSending && !sendError
      ? readReceiptLineForMessage(props.readReceipts, m.id, props.myUserId)
      : null

  const bodyText = previewBody(m)
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

  const statusMarker = sendError ? '✗' : isSending ? '…' : ' '
  const timeCol = props.showTimestamp ? `${time} ` : ''
  const indicator = props.focused ? props.focusIndicatorChar.slice(0, 1) || '>' : ' '
  const statusWidth = props.showTimestamp ? 7 : 2

  return (
    <>
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text
            color={props.focused ? theme.messageFocusIndicator : undefined}
            backgroundColor={
              props.focused ? (theme.messageFocusBackground ?? undefined) : undefined
            }
          >
            {indicator}
          </Text>
        </Box>
        <Box width={statusWidth} flexShrink={0}>
          <Text color={color} wrap="truncate-end">
            {props.showTimestamp ? `${statusMarker}${timeCol}` : `${statusMarker} `}
          </Text>
        </Box>
        <Box width={senderColWidth + 1} flexShrink={0}>
          <Text color={color} bold={!isSystem && senderTrimmed.length > 0} wrap="truncate-end">
            {`${senderTrimmed.padEnd(senderColWidth)} `}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text
            color={
              isDeleted ? theme.mutedText : props.focused ? theme.messageFocusIndicator : color
            }
            italic={isDeleted}
            bold={props.focused && !isDeleted}
            wrap="wrap"
          >
            {bodyText}
            {isEdited && <Text color={theme.mutedText}> (edited)</Text>}
            {reactionLine && <Text color={theme.mutedText}> {`(${reactionLine})`}</Text>}
          </Text>
        </Box>
      </Box>
      {props.threadMeta && props.threadMeta.count > 0 && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box width={statusWidth} flexShrink={0} />
          <Box width={senderColWidth + 1} flexShrink={0} />
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.mutedText} wrap="truncate-end">
              {`╰─ ${formatReplyCount(props.threadMeta)}`}
            </Text>
          </Box>
        </Box>
      )}
      {readReceiptLine && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box width={statusWidth} flexShrink={0} />
          <Box width={senderColWidth + 1} flexShrink={0} />
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.mutedText} wrap="truncate-end">
              {readReceiptLine}
            </Text>
          </Box>
        </Box>
      )}
      {sendError && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box width={statusWidth} flexShrink={0} />
          <Box width={senderColWidth + 1} flexShrink={0} />
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.warnText} wrap="truncate-end">
              {`send failed: ${sendError.slice(0, 120)}`}
            </Text>
          </Box>
        </Box>
      )}
    </>
  )
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
  return htmlToText(raw)
}

// Sender column auto-sizes to the longest first name in the visible
// conversation. Empty / system rows are ignored. The result is clamped
// between SENDER_COL_MIN and SENDER_COL_MAX.
export function computeSenderColWidth(messages: ChatMessage[]): number {
  let max = 0
  for (const m of messages) {
    if (m.messageType === 'systemEventMessage') continue
    const raw = effectiveSenderName(m) ?? ''
    if (!raw) continue
    const len = shortName(raw).length
    if (len > max) max = len
  }
  if (max === 0) return SENDER_COL_MIN
  if (max < SENDER_COL_MIN) return SENDER_COL_MIN
  if (max > SENDER_COL_MAX) return SENDER_COL_MAX
  return max
}

export function formatReplyCount(meta: ThreadMeta): string {
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
      <Box width={2} flexShrink={0} />
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
): string {
  if (focus.kind === 'chat') {
    const chat = chats.find((c) => c.id === focus.chatId)
    if (!chat) return `chat ${focus.chatId.slice(0, 16)}...`
    return chatLabel(chat, myUserId)
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
