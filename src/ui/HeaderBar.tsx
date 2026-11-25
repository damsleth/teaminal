import { Box } from 'ink'
import { Text } from './Text'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { chatLabel, unifiedSidebar } from '../state/selectables'
import {
  accountUnreadCount,
  recentUnreadNotifications,
  unreadTotals,
  type ChatUnreadActivity,
  type ConnectionState,
  type RealtimeState,
} from '../state/store'
import type { Chat } from '../types'
import { useAppState, useTheme } from './StoreContext'
import { useSessionApi } from './SessionContext'
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

// Background accounts with something to say, in configured order:
// `beta 3 · gamma !` (unread count, `!` for auth expired / offline). Entries
// that do not fit in `maxWidth` collapse into `+N`.
export function formatAccountBadge(
  entries: { label: string; mark: string }[],
  maxWidth: number,
): string {
  const parts = entries.map((e) => `${e.label} ${e.mark}`)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out} · ${parts[i]}` : parts[i]!
    const rest = parts.length - i - 1
    if ((rest > 0 ? `${next} · +${rest}` : next).length > maxWidth) {
      const more = `+${parts.length - i}`
      return out ? `${out} · ${more}` : more
    }
    out = next
  }
  return out
}

export function HeaderBar({ columns = 100 }: { columns?: number }) {
  const session = useSessionApi()
  const me = useAppState((s) => s.me)
  const nameByUserId = useAppState((s) => s.nameByUserId)
  const myPresence = useAppState((s) => s.myPresence)
  const conn = useAppState((s) => s.conn)
  const chats = useAppState((s) => s.chats)
  const capabilities = useAppState((s) => s.capabilities)
  const lastListPollAt = useAppState((s) => s.lastListPollAt)
  const unreadByChatId = useAppState((s) => s.unreadByChatId)
  const unreadMentionCount = useAppState((s) => s.unreadMentionCount)
  const realtimeState = useAppState((s) => s.realtimeState)
  const show = useAppState((s) => s.settings.headerElements)
  const userFormat = useAppState((s) => s.settings.headerUserFormat)
  const centered = useAppState((s) => s.settings.headerBarCentered)
  const backgroundAccounts = useAppState((s) => s.backgroundAccounts)
  const configured = useAppState((s) => s.settings.accounts)
  const theme = useTheme()

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const profile = session.getActiveProfile()
  const userName = me?.displayName ?? '...'
  const tenant = tenantFromUpn(me?.userPrincipalName)
  // 'tenant' format collapses to just the tenant (falling back to the profile
  // alias, then the name) so the top row stays short; 'full' shows both.
  const userDisplay =
    userFormat === 'tenant'
      ? (tenant ?? profile ?? userName)
      : tenant
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

  // Empty with one account (single mode has no background accounts), and in
  // the unified sidebar, whose account header rows carry the same counts.
  const unified = useAppState(unifiedSidebar)
  const badge = unified
    ? ''
    : formatAccountBadge(
        Object.values(backgroundAccounts)
          .sort((a, b) => rank(configured, a.ref.label) - rank(configured, b.ref.label))
          .flatMap((a) => {
            const failed = a.conn === 'authError' || a.conn === 'offline'
            const count = accountUnreadCount(a)
            return failed || count > 0
              ? [{ label: a.ref.label, mark: failed ? '!' : String(count) }]
              : []
          }),
        Math.max(4, Math.floor(columns / 4)),
      )

  const updated = formatRelative(lastListPollAt, now)
  const unreadText = formatUnread(unreadByChatId, chats, me?.id, nameByUserId)

  // Build the visible segments, then interleave ` · ` separators so hiding
  // any element never leaves a dangling separator. The app name leads when
  // shown.
  const segments: ReactNode[] = []
  if (show.app)
    segments.push(
      <Text key="app" bold={theme.emphasis.sectionHeadingBold}>
        teaminal
      </Text>,
    )
  if (show.user) segments.push(<Text muted>{userDisplay}</Text>)
  if (badge) segments.push(<Text color={theme.unread}>{badge}</Text>)
  if (show.presence) {
    segments.push(
      presenceUnavailable ? (
        <Text muted>presence n/a</Text>
      ) : (
        <>
          <Text muted>{'presence '}</Text>
          <Text color={presenceColor(theme, myPresence?.availability)}>{DOT}</Text>
        </>
      ),
    )
  }
  if (show.graph) {
    segments.push(
      <>
        <Text muted>{'graph '}</Text>
        <Text color={connColor(conn)}>{DOT}</Text>
      </>,
    )
  }
  if (show.chats) segments.push(<Text muted>{`${chats.length} chats`}</Text>)
  if (show.unread && unreadText) {
    segments.push(<Text color={theme.unread}>{unreadText.toLowerCase()}</Text>)
  }
  if (show.unread && unreadMentionCount > 0) {
    segments.push(<Text color={theme.unread}>{`@${unreadMentionCount}`}</Text>)
  }
  if (show.push && realtimeState !== 'off') {
    segments.push(
      <>
        <Text muted>{'push '}</Text>
        <Text color={realtimeColor(realtimeState)}>{DOT}</Text>
      </>,
    )
  }
  if (show.updated && updated) segments.push(<Text muted>{`upd ${updated}`}</Text>)
  // Capability warnings are not vanity chrome, so they're always shown.
  if (hints.length > 0 && !presenceUnavailable) {
    segments.push(<Text muted>{hints.join(', ')}</Text>)
  }

  // Render the whole bar as a single truncating line. Without this the
  // individual segment <Text> nodes wrap independently when the terminal is
  // narrow, ballooning the bordered header box to several rows (and making it
  // jump as dynamic segments like push/updated change). truncate-end keeps it
  // to exactly one row no matter the width or content.
  return (
    <Box paddingX={1} flexGrow={1} justifyContent={centered ? 'center' : 'flex-start'}>
      <Text wrap="truncate-end">
        {segments.map((seg, i) => (
          <Fragment key={i}>
            {i > 0 && <Text muted>{' · '}</Text>}
            {seg}
          </Fragment>
        ))}
      </Text>
    </Box>
  )
}

function rank(configured: string[], label: string): number {
  const i = configured.indexOf(label)
  return i < 0 ? Number.MAX_SAFE_INTEGER : i
}

function formatUnread(
  unreadByChatId: Record<string, ChatUnreadActivity>,
  chats: Chat[],
  myUserId?: string,
  nameByUserId?: Record<string, string>,
): string | null {
  const totals = unreadTotals(unreadByChatId)
  if (totals.unreadCount <= 0 && totals.mentionCount <= 0) return null
  const parts = [`${totals.unreadCount} unread`]
  if (totals.mentionCount > 0) parts.push(`${totals.mentionCount} mention`)
  const labels = recentUnreadNotifications(unreadByChatId, 3)
    .map((n) => n.lastSenderName ?? chatLabelForId(chats, n.chatId, myUserId, nameByUserId))
    .filter((label): label is string => Boolean(label))
  if (labels.length > 0) parts.push(labels.join(', '))
  return parts.join(' / ')
}

function chatLabelForId(
  chats: Chat[],
  chatId: string,
  myUserId?: string,
  nameByUserId?: Record<string, string>,
): string | undefined {
  const chat = chats.find((c) => c.id === chatId)
  return chat ? chatLabel(chat, myUserId, { compact: true, nameByUserId }) : undefined
}
