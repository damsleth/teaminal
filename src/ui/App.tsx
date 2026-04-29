// Top-level layout + global keybinds + focus management.
//
// Three-pane shell:
//
//   ┌─────────────┬───────────────────────────────┐
//   │  ChatList   │  MessagePane                  │
//   │             │                               │
//   ├─────────────┴───────────────────────────────┤
//   │  Composer                                   │
//   ├─────────────────────────────────────────────┤
//   │  StatusBar                                  │
//   └─────────────────────────────────────────────┘
//
// Step 9 wires the layout + global exit binds; per-pane interactions
// (selection, scroll, send) land in steps 10-15.

import { Box, Text, useApp, useInput, useStdin } from 'ink'
import { ChatList } from './ChatList'
import { Composer } from './Composer'
import { MessagePane } from './MessagePane'
import { StatusBar } from './StatusBar'
import { useAppState } from './StoreContext'

const LIST_PANE_WIDTH = 30

export function App() {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const conn = useAppState((s) => s.conn)

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') exit()
      if (input === 'q') exit()
    },
    { isActive: isRawModeSupported },
  )

  return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold>teaminal</Text>
        <Text color="gray">{`  conn: ${conn}`}</Text>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box width={LIST_PANE_WIDTH} borderStyle="round" borderColor="gray">
          <ChatList />
        </Box>
        <Box flexGrow={1} borderStyle="round" borderColor="gray">
          <MessagePane />
        </Box>
      </Box>
      <Box borderStyle="round" borderColor="gray">
        <Composer />
      </Box>
      <StatusBar />
    </Box>
  )
}
