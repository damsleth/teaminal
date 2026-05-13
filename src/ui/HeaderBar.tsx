import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import { getActiveProfile } from '../graph/client'
import { chatLabel } from '../state/selectables'
import {
  recentUnreadNotifications,
  unreadTotals,
  type ChatUnreadActivity,
  type ConnectionState,
  type RealtimeState,
} from '../state/store'
import type { Chat } from '../types'
import { useAppState, useTheme } from './StoreContext'
import type { PresenceColorKey, Theme } from './theme'

const DOT = '●'

function presenceColor(theme: Theme, availability?: string): string {
  if (!availability) return theme.presence.PresenceUnknown
  const key = availability as PresenceColorKey
  return theme.presence[key] ?? theme.presence.PresenceUnknown
}

function connColor(conn: ConnectionState): string {
  switch (conn) {
    case 'online':
      return 'green'
    case 'rateLimited':
      return 'yellow'
    case 'offline':
    case 'authError':
      return 'red'
    case 'connecting':
    default:
      return 'gray'
  }
}

function realtimeColor(state: RealtimeState): string {
  switch (state) {
    case 'connected':
      return 'green'
    case 'connecting':
    case 'reconnecting':
      return 'yellow'
    case 'error':
      return 'red'
    case 'off':
    default:
      return 'gray'
  }
}

function tenantFromUpn(upn?: string | null): string | null {
  if (!upn) return null
  const at = upn.lastIndexOf('@')
  if (at === -1 || at === upn.length - 1) return null
  return upn.slice(at + 1)
}

function formatRelative(date: Date | undefined, now: number): string | null {
  if (!date) return null
  const ms = now - date.getTime()
  if (ms < 0) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

export function HeaderBar() {
  const me = useAppState((s) => s.me)
  const myPresence = useAppState((s) => s.myPresence)
  const conn = useAppState((s) => s.conn)
  const chats = useAppState((s) => s.chats)
  const capabilities = useAppState((s) => s.capabilities)
  const lastListPollAt = useAppState((s) => s.lastListPollAt)
  const unreadByChatId = useAppState((s) => s.unreadByChatId)
  const realtimeState = useAppState((s) => s.realtimeState)
  const theme = useTheme()

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const profile = getActiveProfile()
  const userName = me?.displayName ?? '...'
  const tenant = tenantFromUpn(me?.userPrincipalName)
  const userDisplay = tenant
    ? `${userName} (${tenant})`
    : profile
      ? `${userName} (${profile})`
      : userName

  const presenceUnavailable =
    capabilities?.presence.ok === false && capabilities.presence.reason === 'unavailable'

  const hints: string[] = []
  if (capabilities) {
    if (!capabilities.presence.ok) hints.push('presence n/a')
    if (!capabilities.joinedTeams.ok) hints.push('teams n/a')
    if (!capabilities.chats.ok) hints.push('chats n/a')
    if (!capabilities.me.ok) hints.push('me n/a')
  }

  const updated = formatRelative(lastListPollAt, now)
  const unreadText = formatUnread(unreadByChatId, chats, me?.id)

  return (
    <Box paddingX={theme.layout.panePaddingX}>
      <Text bold={theme.emphasis.sectionHeadingBold}>teaminal</Text>
      <Text color="gray">{' · '}</Text>
      <Text color="gray">{userDisplay}</Text>
      <Text color="gray">{' · '}</Text>
      {presenceUnavailable ? (
        <Text color="gray">presence n/a</Text>
      ) : (
        <>
          <Text color="gray">{'presence '}</Text>
          <Text color={presenceColor(theme, myPresence?.availability)}>{DOT}</Text>
          <Text color="gray">{` ${(myPresence?.availability ?? '?').toLowerCase()}`}</Text>
        </>
      )}
      <Text color="gray">{' · '}</Text>
      <Text color="gray">{'graph '}</Text>
      <Text color={connColor(conn)}>{DOT}</Text>
      <Text color="gray">{` ${conn}`}</Text>
      <Text color="gray">{` · ${chats.length} chats`}</Text>
      {unreadText && <Text color={theme.unread}>{` · ${unreadText.toLowerCase()}`}</Text>}
      {realtimeState !== 'off' && (
        <>
          <Text color="gray">{' · push '}</Text>
          <Text color={realtimeColor(realtimeState)}>{DOT}</Text>
          <Text color="gray">{` ${realtimeState}`}</Text>
        </>
      )}
      {updated && <Text color="gray">{` · upd ${updated}`}</Text>}
      {hints.length > 0 && !presenceUnavailable && (
        <Text color="gray">{` · ${hints.join(', ')}`}</Text>
      )}
    </Box>
  )
}

function formatUnread(
  unreadByChatId: Record<string, ChatUnreadActivity>,
  chats: Chat[],
  myUserId?: string,
): string | null {
  const totals = unreadTotals(unreadByChatId)
  if (totals.unreadCount <= 0 && totals.mentionCount <= 0) return null
  const parts = [`${totals.unreadCount} unread`]
  if (totals.mentionCount > 0) parts.push(`${totals.mentionCount} mention`)
  const labels = recentUnreadNotifications(unreadByChatId, 3)
    .map((n) => n.lastSenderName ?? chatLabelForId(chats, n.chatId, myUserId))
    .filter((label): label is string => Boolean(label))
  if (labels.length > 0) parts.push(labels.join(', '))
  return parts.join(' / ')
}

function chatLabelForId(chats: Chat[], chatId: string, myUserId?: string): string | undefined {
  const chat = chats.find((c) => c.id === chatId)
  return chat ? chatLabel(chat, myUserId, { compact: true }) : undefined
}
