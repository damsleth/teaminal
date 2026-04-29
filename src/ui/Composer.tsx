// Bottom strip: multi-line input.
//
// Step 9 placeholder - real input + sendMessage / sendChannelMessage wiring
// with optimistic-append + rollback lands in step 11.

import { Box, Text } from 'ink'
import { useAppState } from './StoreContext'

export function Composer() {
  const focus = useAppState((s) => s.focus)
  const placeholder = focus.kind === 'list' ? 'open a chat to compose' : '> _'
  return (
    <Box paddingX={1}>
      <Text color="gray">{placeholder}</Text>
    </Box>
  )
}
