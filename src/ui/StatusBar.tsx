// Bottom row: profile, presence, conn state, chat count, capability hints.
//
// Layout:
//   alice · ● Available · 17 chats · online
// or, when capabilities or auth degrade:
//   alice · presence n/a · 17 chats · authError · presence n/a, channels n/a
//
// Color cues:
//   conn:
//     online      green
//     connecting  gray
//     offline     red
//     authError   red
//     rateLimited yellow
//   presence dot color comes from theme.presence keyed by availability.

import { Box, Text } from 'ink'
import { getActiveProfile } from '../graph/client'
import type { ConnectionState } from '../state/store'
import { theme, type PresenceColorKey } from './theme'
import { useAppState } from './StoreContext'

function presenceColor(availability?: string): string {
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

export function StatusBar() {
  const me = useAppState((s) => s.me)
  const myPresence = useAppState((s) => s.myPresence)
  const conn = useAppState((s) => s.conn)
  const chatCount = useAppState((s) => s.chats.length)
  const capabilities = useAppState((s) => s.capabilities)

  const profile = getActiveProfile()
  const nameDisplay = profile ? `${me?.displayName ?? '...'} (${profile})` : me?.displayName ?? '...'

  const presenceUnavailable =
    capabilities?.presence.ok === false && capabilities.presence.reason === 'unavailable'

  // Compact hints for capability gaps that affect daily UX. Only render
  // when at least one is degraded; an OK probe is implicit in normal
  // operation.
  const hints: string[] = []
  if (capabilities) {
    if (!capabilities.presence.ok) hints.push('presence n/a')
    if (!capabilities.joinedTeams.ok) hints.push('teams n/a')
    if (!capabilities.chats.ok) hints.push('chats n/a')
    if (!capabilities.me.ok) hints.push('me n/a')
  }

  return (
    <Box paddingX={1}>
      <Text color="gray">{nameDisplay}</Text>
      <Text color="gray">{' · '}</Text>
      {presenceUnavailable ? (
        <Text color="gray">presence n/a</Text>
      ) : (
        <>
          <Text color={presenceColor(myPresence?.availability)}>●</Text>
          <Text color="gray">{` ${myPresence?.availability ?? '?'}`}</Text>
        </>
      )}
      <Text color="gray">{` · ${chatCount} chats · `}</Text>
      <Text color={connColor(conn)}>{conn}</Text>
      {hints.length > 0 && !presenceUnavailable && (
        <Text color="gray">{` · ${hints.join(', ')}`}</Text>
      )}
    </Box>
  )
}
