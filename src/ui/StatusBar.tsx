// Bottom row: profile, presence dot, conn state, chat count.

import { Box, Text } from 'ink'
import { theme, type PresenceColorKey } from './theme'
import { useAppState } from './StoreContext'

function presenceColor(availability?: string): string {
  if (!availability) return theme.presence.PresenceUnknown
  const key = availability as PresenceColorKey
  return theme.presence[key] ?? theme.presence.PresenceUnknown
}

export function StatusBar() {
  const me = useAppState((s) => s.me)
  const myPresence = useAppState((s) => s.myPresence)
  const conn = useAppState((s) => s.conn)
  const chatCount = useAppState((s) => s.chats.length)
  const capabilities = useAppState((s) => s.capabilities)

  const presenceLabel = myPresence?.availability ?? '?'
  const presenceUnavailable =
    capabilities?.presence.ok === false && capabilities.presence.reason === 'unavailable'

  return (
    <Box paddingX={1}>
      <Text color="gray">{me?.displayName ?? '...'} · </Text>
      {presenceUnavailable ? (
        <Text color="gray">presence n/a · </Text>
      ) : (
        <>
          <Text color={presenceColor(myPresence?.availability)}>●</Text>
          <Text color="gray">{` ${presenceLabel} · `}</Text>
        </>
      )}
      <Text color="gray">{`${chatCount} chats · ${conn}`}</Text>
    </Box>
  )
}
