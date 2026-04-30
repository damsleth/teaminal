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
import type { Theme } from './theme'
import { useAppState, useTheme } from './StoreContext'

const ROWS_VISIBLE = 20
// Narrow column - message rows show first name / nick only. The chat /
// channel header above already shows the full display name(s), so the
// per-row column doesn't need to disambiguate.
const SENDER_COL_WIDTH = 10

export function MessagePane() {
  const focus = useAppState((s) => s.focus)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const me = useAppState((s) => s.me)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const showTimestamps = useAppState((s) => s.settings.showTimestampsInPane)
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
  const visible = messages.slice(-ROWS_VISIBLE)

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold>{headerLabel}</Text>
      <Box flexDirection="column">
        {messages.length === 0 ? (
          <Text color="gray">  loading...</Text>
        ) : (
          visible.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
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

function MessageRow(props: {
  message: ChatMessage
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
  const timeCol = props.showTimestamp ? `${time}  ` : ''

  return (
    <>
      <Text color={color}>
        {`${statusMarker} ${timeCol}${senderTrimmed.padEnd(SENDER_COL_WIDTH)}  ${bodyText}`}
      </Text>
      {sendError && (
        <Text color={theme.warnText}>{`     send failed: ${sendError.slice(0, 120)}`}</Text>
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
