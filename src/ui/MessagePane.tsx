// Center pane: message timeline.
//
// Renders messages in chronological order (poller already reverses Graph's
// descending API result). System messages (messageType=systemEventMessage)
// are styled gray and labeled. Self messages get a subtle color cue.
//
// HTML message bodies are still raw at this step - step 12 wires the
// htmlparser2 -> ANSI/text conversion. For now we strip a tiny set of
// tags inline so the placeholder doesn't read as garbage.

import { Box, Text } from 'ink'
import { chatLabel } from '../state/selectables'
import { focusKey } from '../state/store'
import type { Chat, ChatMessage, Channel, Team } from '../types'
import { theme } from './theme'
import { useAppState } from './StoreContext'

const ROWS_VISIBLE = 20
const SENDER_COL_WIDTH = 16

export function MessagePane() {
  const focus = useAppState((s) => s.focus)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const me = useAppState((s) => s.me)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)

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
          visible.map((m) => <MessageRow key={m.id} message={m} myUserId={me?.id} />)
        )}
      </Box>
    </Box>
  )
}

function MessageRow(props: { message: ChatMessage; myUserId?: string }) {
  const m = props.message
  const time = m.createdDateTime.slice(11, 16)
  const sender = m.from?.user?.displayName ?? '(system)'
  const senderTrimmed = sender.length > SENDER_COL_WIDTH ? sender.slice(0, SENDER_COL_WIDTH - 1) + '…' : sender
  const isSystem = m.messageType === 'systemEventMessage' || sender === '(system)'
  const isSelf = !!props.myUserId && m.from?.user?.id === props.myUserId

  const bodyText = previewBody(m)

  let color: string | undefined
  if (isSystem) color = theme.systemEvent
  else if (isSelf) color = theme.selfMessage

  return (
    <Text color={color}>
      {`  ${time}  ${senderTrimmed.padEnd(SENDER_COL_WIDTH)}  ${bodyText}`}
    </Text>
  )
}

// Crude text extraction for HTML bodies. Step 12 replaces this with a
// proper htmlparser2 + entities pass. Until then this keeps the row from
// reading as <p>...</p> tags but doesn't promise correct rendering of
// <at>, <emoji>, <a>, etc.
function previewBody(m: ChatMessage): string {
  if (m.messageType === 'systemEventMessage') {
    return '(system event)'
  }
  const raw = m.body.content ?? ''
  if (m.body.contentType === 'text') return raw.replace(/\s+/g, ' ').trim().slice(0, 200)
  // very rough HTML strip; keeps content readable in v1
  const stripped = raw
    .replace(/<\/?(?:p|br)\s*\/?>/gi, ' ')
    .replace(/<emoji[^>]*alt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<at[^>]*>(.*?)<\/at>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.slice(0, 200)
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
