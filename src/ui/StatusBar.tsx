// Bottom row: compact input-mode and key hints. Profile, presence,
// capability, unread, and refresh details live in HeaderBar.

import { Box, Text } from 'ink'
import { useAppState } from './StoreContext'

export function StatusBar() {
  const focus = useAppState((s) => s.focus)
  const inputZone = useAppState((s) => s.inputZone)
  const filter = useAppState((s) => s.filter)

  let hint = 'j/k move · L/Enter open · / filter · N new chat · ? help · q quit'
  if (inputZone === 'filter') hint = 'type to filter · Enter accept · Esc clear'
  else if (inputZone === 'composer') hint = 'Enter send · Ctrl+J newline · Esc navigation'
  else if (inputZone === 'menu') hint = 'menu open'
  else if (focus.kind !== 'list') {
    hint = 'J/K message · U/D half-page · L bottom · H back · Tab compose · r refresh'
  }

  return (
    <Box paddingX={1}>
      <Text color="gray">{hint}</Text>
      {filter && inputZone !== 'filter' && <Text color="gray">{` · / ${filter}`}</Text>}
    </Box>
  )
}
