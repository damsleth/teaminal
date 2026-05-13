// Bottom row: compact input-mode and key hints. Profile, presence,
// capability, unread, and refresh details live in HeaderBar.

import { Box, Text } from 'ink'
import { useAppState, useTheme } from './StoreContext'

export function StatusBar() {
  const focus = useAppState((s) => s.focus)
  const inputZone = useAppState((s) => s.inputZone)
  const filter = useAppState((s) => s.filter)
  const theme = useTheme()

  let hint = 'j/k move · l/Enter open · / filter · n new chat · ? help · q quit'
  if (inputZone === 'filter') hint = 'type to filter · Enter accept · Esc clear'
  else if (inputZone === 'composer') hint = 'Enter send · Ctrl+J newline · Tab chat'
  else if (inputZone === 'menu') hint = 'menu open'
  else if (focus.kind !== 'list') {
    hint = 'j/k msg · u/d half · u/k older top · l bottom · h back · Tab compose · r refresh'
  }

  return (
    <Box paddingX={theme.layout.panePaddingX}>
      <Text color={theme.mutedText} wrap="truncate-end">
        {hint}
        {filter && inputZone !== 'filter' ? ` · / ${filter}` : ''}
      </Text>
    </Box>
  )
}
