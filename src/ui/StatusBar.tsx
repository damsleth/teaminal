// Bottom row: user, tenant, presence, conn state, chat count, last-updated,
// capability hints.
//
// Layout (representative):
//   alice (crayon.no) · ● Available · ● online · 17 chats · upd 5s ago
//
// Colors:
//   conn dot:
//     online       green
//     connecting   gray
//     offline      red
//     authError    red
//     rateLimited  yellow
//   presence dot color comes from theme.presence keyed by availability.
//
// Connection-status dot uses the Unicode solid bullet (●). Not an emoji,
// renders consistently across terminal fonts; nerd-font users can swap to
// nf-fa-circle () without code changes by editing CONN_DOT.

import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import { getActiveProfile } from '../graph/client'
import type { ConnectionState } from '../state/store'
import { useAppState, useTheme } from './StoreContext'
import type { PresenceColorKey, Theme } from './theme'

const CONN_DOT = '●'

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

// "tenant" is rendered as the verified-domain part of the user's UPN.
// Real tenant id is a UUID claim ('tid') but the domain is what humans
// recognize ("crayon.no", "softwareone.com"). Falls back to null when
// UPN is unavailable or malformed.
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

export function StatusBar() {
  const me = useAppState((s) => s.me)
  const myPresence = useAppState((s) => s.myPresence)
  const conn = useAppState((s) => s.conn)
  const chatCount = useAppState((s) => s.chats.length)
  const capabilities = useAppState((s) => s.capabilities)
  const lastListPollAt = useAppState((s) => s.lastListPollAt)
  const theme = useTheme()

  // Drive a 1Hz tick so "Ns ago" stays current. Cheap - one render per
  // second only updates the relative-time label.
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

  return (
    <Box paddingX={1}>
      <Text color="gray">{userDisplay}</Text>
      <Text color="gray">{' · '}</Text>
      {presenceUnavailable ? (
        <Text color="gray">presence n/a</Text>
      ) : (
        <>
          <Text color={presenceColor(theme, myPresence?.availability)}>{CONN_DOT}</Text>
          <Text color="gray">{` ${myPresence?.availability ?? '?'}`}</Text>
        </>
      )}
      <Text color="gray">{' · '}</Text>
      <Text color={connColor(conn)}>{CONN_DOT}</Text>
      <Text color="gray">{` ${conn}`}</Text>
      <Text color="gray">{` · ${chatCount} chats`}</Text>
      {updated && <Text color="gray">{` · upd ${updated}`}</Text>}
      {hints.length > 0 && !presenceUnavailable && (
        <Text color="gray">{` · ${hints.join(', ')}`}</Text>
      )}
    </Box>
  )
}
