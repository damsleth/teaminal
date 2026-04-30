// Center pane: message timeline.
//
// Renders messages in chronological order (poller already reverses Graph's
// descending API result). System messages (messageType=systemEventMessage)
// are styled gray and labeled. Self messages get a subtle color cue.
// HTML bodies are converted via src/ui/html.htmlToText so <at>, <emoji>,
// <a>, and entity refs render correctly.

import { Box, Text } from 'ink'
import { chatLabel, shortName } from '../state/selectables'
import { focusKey } from '../state/store'
import type { Chat, ChatMessage, Channel, Team } from '../types'
import { htmlToText } from './html'
import {
  buildMessageRows,
  readMessagePageState,
  type LoadMoreState,
  type MessageRenderRow,
} from './messageRows'
import type { Theme } from './theme'
import { useAppState, useTheme } from './StoreContext'

const ROWS_VISIBLE = 20
// Narrow column - message rows show first name / nick only. The chat /
// channel header above already shows the full display name(s), so the
// per-row column doesn't need to disambiguate.
const SENDER_COL_WIDTH = 10

export function MessagePane(props: {
  focusedMessageId?: string | null
  focusIndicatorActive?: boolean
  loadOlderState?: LoadMoreState
}) {
  const focus = useAppState((s) => s.focus)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const me = useAppState((s) => s.me)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const showTimestamps = useAppState((s) => s.settings.showTimestampsInPane)
  const density = useAppState((s) => s.settings.chatListDensity)
  const focusIndicatorVisible = useAppState((s) => s.settings.messageFocusIndicatorEnabled)
  const focusIndicatorChar = useAppState((s) => s.settings.messageFocusIndicatorChar)
  const theme = useTheme()

  if (focus.kind === 'list') {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Text color="gray">Select a chat or channel · Enter to open · q to quit</Text>
      </Box>
    )
  }

  const conv = focusKey(focus)!
  const messages = messagesByConvo[conv] ?? []
  const headerLabel = headerForFocus(focus, chats, teams, channelsByTeam, me?.id)
  const focusedIndex = props.focusedMessageId
    ? messages.findIndex((m) => m.id === props.focusedMessageId)
    : -1
  const start = visibleStart(messages.length, focusedIndex, props.focusIndicatorActive === true)
  const visible = messages.slice(start, start + ROWS_VISIBLE)
  const pageState = readMessagePageState(messages)
  const loadMoreState =
    props.loadOlderState ??
    (pageState.loading
      ? 'loading'
      : pageState.error
        ? 'error'
        : pageState.hasOlder
          ? 'idle'
          : 'unavailable')
  const rows = buildMessageRows(visible, {
    showLoadMoreRow: messages.length > 0 && start === 0,
    loadMoreState,
  })
  const showFocusIndicator =
    props.focusIndicatorActive === true && focusIndicatorVisible && messages.length > 0

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {density === 'cozy' && <Text bold>{headerLabel}</Text>}
      <Box flexDirection="column">
        {messages.length === 0 ? (
          <Text color="gray"> loading...</Text>
        ) : (
          rows.map((row) => (
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
              myUserId={me?.id}
              showTimestamp={showTimestamps}
              theme={theme}
            />
          ))
        )}
      </Box>
    </Box>
  )
}

function TimelineRow(props: {
  row: MessageRenderRow
  focused: boolean
  focusIndicatorChar: string
  myUserId?: string
  showTimestamp: boolean
  theme: Theme
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
        <Text color={active ? props.theme.selected : 'gray'}>
          {active ? 'Enter/L ' : ''}
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
      myUserId={props.myUserId}
      showTimestamp={props.showTimestamp}
      theme={props.theme}
    />
  )
}

function MessageRow(props: {
  message: ChatMessage
  focused: boolean
  focusIndicatorChar: string
  myUserId?: string
  showTimestamp: boolean
  theme: Theme
}) {
  const { theme } = props
  const m = props.message
  const time = m.createdDateTime.slice(11, 16)
  const rawSender = m.from?.user?.displayName ?? '(system)'
  const isSystem = m.messageType === 'systemEventMessage' || rawSender === '(system)'
  const senderShort = isSystem ? '(system)' : shortName(rawSender)
  const senderTrimmed =
    senderShort.length > SENDER_COL_WIDTH
      ? senderShort.slice(0, SENDER_COL_WIDTH - 1) + '…'
      : senderShort
  const isSelf = !!props.myUserId && m.from?.user?.id === props.myUserId
  const isSending = m._sending === true
  const sendError = m._sendError

  const bodyText = previewBody(m)

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
  const statusWidth = props.showTimestamp ? 8 : 2

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
          <Text color={color}>
            {props.showTimestamp ? `${statusMarker} ${timeCol}` : `${statusMarker} `}
          </Text>
        </Box>
        <Box width={SENDER_COL_WIDTH + 2} flexShrink={0}>
          <Text color={color}>{`${senderTrimmed.padEnd(SENDER_COL_WIDTH)}  `}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color={props.focused ? theme.messageFocusIndicator : color} bold={props.focused}>
            {bodyText}
          </Text>
        </Box>
      </Box>
      {sendError && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box width={statusWidth} flexShrink={0} />
          <Box width={SENDER_COL_WIDTH + 2} flexShrink={0} />
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.warnText}>{`send failed: ${sendError.slice(0, 120)}`}</Text>
          </Box>
        </Box>
      )}
    </>
  )
}

function previewBody(m: ChatMessage): string {
  if (m.messageType === 'systemEventMessage') {
    return '(system event)'
  }
  const raw = m.body.content ?? ''
  if (m.body.contentType === 'text') {
    return raw.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  return htmlToText(raw).slice(0, 200)
}

function visibleStart(total: number, focusedIndex: number, focusActive: boolean): number {
  if (total <= ROWS_VISIBLE) return 0
  if (!focusActive || focusedIndex < 0) return total - ROWS_VISIBLE
  const preferred = focusedIndex - ROWS_VISIBLE + 1
  if (preferred < 0) return 0
  if (preferred > total - ROWS_VISIBLE) return total - ROWS_VISIBLE
  return preferred
}

function headerForFocus(
  focus: { kind: 'chat'; chatId: string } | { kind: 'channel'; teamId: string; channelId: string },
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
  return `${teamName} · # ${channelName}`
}
