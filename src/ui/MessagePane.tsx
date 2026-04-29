// Center pane: message timeline.
//
// Step 9 placeholder - real rendering with html->ANSI lands in steps 10/12.

import { Box, Text } from 'ink'
import { focusKey } from '../state/store'
import { useAppState } from './StoreContext'

export function MessagePane() {
  const focus = useAppState((s) => s.focus)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)

  if (focus.kind === 'list') {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Text color="gray">Select a chat or channel to view messages</Text>
      </Box>
    )
  }

  const conv = focusKey(focus)!
  const messages = messagesByConvo[conv] ?? []

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold>{label(focus)}</Text>
      <Box flexDirection="column">
        {messages.length === 0 ? (
          <Text color="gray">  loading...</Text>
        ) : (
          messages.slice(-20).map((m) => {
            const sender = m.from?.user?.displayName ?? '(system)'
            const time = m.createdDateTime.slice(11, 16)
            const preview = (m.body.content ?? '').slice(0, 80).replace(/\s+/g, ' ').trim()
            return (
              <Text key={m.id}>{`  ${time}  ${sender.slice(0, 14).padEnd(14)}  ${preview}`}</Text>
            )
          })
        )}
      </Box>
    </Box>
  )
}

function label(
  focus: { kind: 'chat'; chatId: string } | { kind: 'channel'; teamId: string; channelId: string },
): string {
  if (focus.kind === 'chat') return `chat ${focus.chatId.slice(0, 24)}...`
  return `channel ${focus.channelId.slice(0, 16)}...`
}
