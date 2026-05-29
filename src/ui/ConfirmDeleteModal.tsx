// Confirmation overlay before soft-deleting the user's own chat message.
//
// Opened by the chat-zone `x` key. `y` / Enter confirms (optimistic delete +
// Graph softDelete via deleteChatMessageById); `n` / Esc cancels.

import { Box, Text, useApp, useInput } from 'ink'
import { deleteChatMessageById } from '../state/chatActions'
import { useAppState, useAppStore, useTheme } from './StoreContext'

export function ConfirmDeleteModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const theme = useTheme()
  const isOpen = modal?.kind === 'confirm-delete'

  useInput(
    (input, key) => {
      if (!isOpen || modal.kind !== 'confirm-delete') return
      if (key.ctrl && input.toLowerCase() === 'c') {
        exit()
        return
      }
      const ch = input.toLowerCase()
      if (key.escape || ch === 'n') {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      if (key.return || ch === 'y') {
        const { chatId, messageId } = modal
        store.set({ modal: null, inputZone: 'list' })
        void deleteChatMessageById(store, chatId, messageId)
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen || modal.kind !== 'confirm-delete') return null

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borders.modal}
      borderColor={theme.borderActive}
      backgroundColor={theme.background}
      paddingX={theme.layout.modalPaddingX}
      paddingY={theme.layout.modalPaddingY}
    >
      <Text bold={theme.emphasis.modalTitleBold}>Delete message?</Text>
      {modal.preview && (
        <Box marginTop={1}>
          <Text color={theme.mutedText} wrap="truncate-end">
            {`"${modal.preview}"`}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.mutedText}>y / enter to delete · n / esc to cancel</Text>
      </Box>
    </Box>
  )
}
