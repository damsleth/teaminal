// Reaction picker for the focused chat message.
//
// Opened by the chat-zone `r` key (App routes input here while the overlay is
// open). Rather than render our own fixed emoji grid, we delegate to the macOS
// Character Viewer: on open we pop the system picker (⌃⌘Space), then capture
// the glyph it inserts into the terminal and send that as the reaction. This
// gives the user the full system emoji set and matches the Graph setReaction
// API, which wants the unicode glyph. Esc cancels.

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect } from 'react'
import { toggleReaction } from '../state/chatActions'
import { openSystemEmojiPicker } from './emojiPicker'
import { isEmojiGlyph } from './reactions'
import { useAppState, useAppStore, useTheme } from './StoreContext'

export function ReactionPickerModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const me = useAppState((s) => s.me)
  const theme = useTheme()
  const isOpen = modal?.kind === 'reaction-picker'

  // Pop the system emoji picker once, when the overlay opens.
  useEffect(() => {
    if (isOpen) openSystemEmojiPicker()
  }, [isOpen])

  useInput(
    (input, key) => {
      if (!isOpen || modal.kind !== 'reaction-picker') return
      if (key.escape) {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      if (key.ctrl && input.toLowerCase() === 'c') {
        exit()
        return
      }
      // The picker inserts the chosen emoji as terminal input. Ignore anything
      // that isn't an emoji (a stray keypress) so we never react with junk.
      if (!isEmojiGlyph(input)) return
      const { chatId, messageId } = modal
      store.set({ modal: null, inputZone: 'list' })
      // toggleReaction logs + rolls back its optimistic update on failure;
      // swallow the rejection so a Graph error never escapes as an unhandled
      // rejection and tears down the TUI.
      if (me) void toggleReaction(store, chatId, messageId, input.trim(), me).catch(() => {})
    },
    { isActive: isOpen },
  )

  if (!isOpen || modal.kind !== 'reaction-picker') return null

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borders.modal}
      borderColor={theme.borderActive}
      backgroundColor={theme.background}
      paddingX={theme.layout.modalPaddingX}
      paddingY={theme.layout.modalPaddingY}
    >
      <Text bold={theme.emphasis.modalTitleBold}>React</Text>
      <Box marginTop={1}>
        <Text color={theme.mutedText}>pick an emoji from the system picker · esc cancels</Text>
      </Box>
    </Box>
  )
}
