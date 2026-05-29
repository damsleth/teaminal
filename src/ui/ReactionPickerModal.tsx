// Reaction picker overlay for the focused chat message.
//
// Opened by the chat-zone `r` key (App routes input here while the modal is
// open). Number keys 1-6 pick one of Graph's documented reactions; the same
// reaction the user already set is marked and re-selecting it removes it
// (toggleReaction handles the toggle). Esc cancels.

import { Box, Text, useApp, useInput } from 'ink'
import { toggleReaction } from '../state/chatActions'
import { reactionGlyph } from './reactions'
import { useAppState, useAppStore, useTheme } from './StoreContext'

// Order matches Teams' own picker and the 1-6 hotkeys below.
const PICKER_REACTIONS = ['like', 'heart', 'laugh', 'surprised', 'sad', 'angry'] as const

export function ReactionPickerModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const me = useAppState((s) => s.me)
  const theme = useTheme()
  const isOpen = modal?.kind === 'reaction-picker'

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
      const idx = Number.parseInt(input, 10) - 1
      if (Number.isInteger(idx) && idx >= 0 && idx < PICKER_REACTIONS.length) {
        const type = PICKER_REACTIONS[idx]!
        const { chatId, messageId } = modal
        store.set({ modal: null, inputZone: 'list' })
        if (me) void toggleReaction(store, chatId, messageId, type, me)
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen || modal.kind !== 'reaction-picker') return null

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borders.modal}
      borderColor={theme.borderActive}
      paddingX={theme.layout.modalPaddingX}
      paddingY={theme.layout.modalPaddingY}
    >
      <Text bold={theme.emphasis.modalTitleBold}>React</Text>
      <Box marginTop={1} flexDirection="row">
        {PICKER_REACTIONS.map((type, i) => {
          const selected = modal.current === type
          return (
            <Box key={type} marginRight={2}>
              <Text color={selected ? theme.selected : undefined} bold={selected}>
                {`${i + 1} ${reactionGlyph(type)}`}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.mutedText}>
          {modal.current ? 'press the marked one to remove · esc cancels' : '1-6 to react · esc cancels'}
        </Text>
      </Box>
    </Box>
  )
}
