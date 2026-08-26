// Confirmation overlay for the two destructive actions: soft-deleting the
// user's own chat message (chat-zone `x`) and deleting a whole chat
// (ctrl+d). `y` / Enter confirms, `n` / Esc cancels.

import { Box, Text, useApp, useInput } from 'ink'
import { deleteChatById, deleteChatMessageById } from '../state/chatActions'
import { useAppState, useAppStore, useTheme } from './StoreContext'

export function ConfirmDeleteModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const theme = useTheme()
  const isOpen = modal?.kind === 'confirm-delete' || modal?.kind === 'confirm-delete-chat'

  useInput(
    (input, key) => {
      if (!isOpen || !modal) return
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
        store.set({ modal: null, inputZone: 'list' })
        // Both actions log + roll back on failure; swallow the rejection so a
        // Graph error never escapes as an unhandled rejection and tears down
        // the TUI.
        if (modal.kind === 'confirm-delete-chat') {
          void deleteChatById(store, modal.chatId).catch(() => {})
        } else if (modal.kind === 'confirm-delete') {
          void deleteChatMessageById(store, modal.chatId, modal.messageId).catch(() => {})
        }
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen || !modal) return null
  const isChat = modal.kind === 'confirm-delete-chat'

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borders.modal}
      borderColor={theme.borderActive}
      backgroundColor={theme.background}
      paddingX={theme.layout.modalPaddingX}
      paddingY={theme.layout.modalPaddingY}
    >
      <Text bold={theme.emphasis.modalTitleBold}>
        {isChat ? 'Delete chat?' : 'Delete message?'}
      </Text>
      {modal.kind === 'confirm-delete-chat' ? (
        <>
          <Box marginTop={1}>
            <Text wrap="truncate-end">{modal.label}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.mutedText}>
              removed from your chat list · returns if someone posts again
            </Text>
          </Box>
        </>
      ) : (
        modal.kind === 'confirm-delete' &&
        modal.preview && (
          <Box marginTop={1}>
            <Text color={theme.mutedText} wrap="truncate-end">
              {`"${modal.preview}"`}
            </Text>
          </Box>
        )
      )}
      <Box marginTop={1}>
        <Text color={theme.mutedText}>y / enter to delete · n / esc to cancel</Text>
      </Box>
    </Box>
  )
}
