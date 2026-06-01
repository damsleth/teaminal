// Compact input-mode and key hints on a single row, rendered at the bottom
// or top of the layout per settings.statusBarPosition. Profile, presence,
// capability, unread, and refresh details live in HeaderBar.

import { Box, Text } from 'ink'
import { selectFocusedAttachment } from './messageFocusables'
import { useAppState, useTheme } from './StoreContext'

export function StatusBar() {
  const focus = useAppState((s) => s.focus)
  const inputZone = useAppState((s) => s.inputZone)
  const filter = useAppState((s) => s.filter)
  const chatListWidthSetting = useAppState((s) => s.settings.chatListWidth)
  const composerHeightSetting = useAppState((s) => s.settings.composerHeight)
  // Description of the currently-focused attachment (image / link), or null
  // when focus is on a message body. Returns a primitive so the selector is
  // stable across unrelated store updates.
  const attachmentHint = useAppState((s) => {
    const f = selectFocusedAttachment(s)
    if (!f) return null
    if (f.kind === 'image') return `▸ image: ${f.ref.name} · space opens`
    if (f.kind === 'link') return `▸ link: ${f.ref.href} · space opens`
    return null
  })
  const theme = useTheme()

  let hint = 'j/k move · l/Enter open · / filter · n new chat · ? help · q quit'
  if (inputZone === 'filter') hint = 'type to filter · Enter accept · Esc clear'
  else if (inputZone === 'composer') hint = 'Enter send · Ctrl+J newline · Tab chat'
  else if (inputZone === 'menu') hint = 'menu open'
  else if (inputZone === 'resize') {
    const listLabel = chatListWidthSetting != null ? `${chatListWidthSetting} cols` : 'auto'
    const composerLabel = composerHeightSetting != null ? `${composerHeightSetting} rows` : 'auto'
    hint = `resize: h/l list ${listLabel} · j/k composer ${composerLabel} · 0 reset · Esc done`
  } else if (focus.kind !== 'list') {
    hint =
      attachmentHint ??
      'j/k msg · u/d half · u/k older top · l bottom · h back · Tab compose · r refresh'
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
