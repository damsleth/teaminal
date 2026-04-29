// Left pane: unified list of chats + channels.
//
// Step 9 placeholder - real selection / scrolling lands in step 10.

import { Box, Text } from 'ink'
import { useAppState } from './StoreContext'

export function ChatList() {
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const conn = useAppState((s) => s.conn)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Chats</Text>
      {chats.length === 0 ? (
        <Text color="gray">{conn === 'connecting' ? '  loading...' : '  (none)'}</Text>
      ) : (
        chats.slice(0, 12).map((c) => {
          const label = c.topic ?? '(no topic)'
          return (
            <Text key={c.id}>{`  ${label.slice(0, 24)}`}</Text>
          )
        })
      )}
      <Box height={1} />
      <Text bold>Teams</Text>
      {teams.length === 0 ? (
        <Text color="gray">  (none)</Text>
      ) : (
        teams.slice(0, 8).map((t) => <Text key={t.id}>{`  ${t.displayName.slice(0, 24)}`}</Text>)
      )}
    </Box>
  )
}
