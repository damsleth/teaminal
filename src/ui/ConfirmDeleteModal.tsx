// Confirmation overlay for the two destructive actions: soft-deleting the
// user's own chat message (chat-zone `x`) and deleting a whole chat
// (ctrl+d). `y` / Enter confirms, `n` / Esc cancels.

import { Box, useApp } from 'ink'
import { Text } from './Text'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'
import { accountRef } from '../account'
import { accountStore, accountStoreFor } from '../state/accountStore'
import { deleteChatById, deleteChatMessageById } from '../state/chatActions'
import { foregroundLabel, labelSuffix } from '../state/selectables'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { useSessionApi } from './SessionContext'

export function ConfirmDeleteModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const session = useSessionApi()
  const modal = useAppState((s) => s.modal)
  const theme = useTheme()
  const label = useAppState(foregroundLabel)
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
        // A chat row of another account in the unified sidebar is deleted
        // in that account; the foreground stays.
        const owner =
          modal.kind === 'confirm-delete-chat' && modal.alias !== undefined
            ? accountRef(modal.alias)
            : null
        const { focus, account } = store.get()
        const deletingFocused =
          modal.kind === 'confirm-delete-chat' &&
          (!owner || owner.id === account?.id) &&
          focus.kind === 'chat' &&
          focus.chatId === modal.chatId
        store.set({
          modal: null,
          inputZone: 'list',
          ...(deletingFocused ? { focus: { kind: 'list' } } : {}),
        })
        // Both actions log + roll back on failure; swallow the rejection so a
        // Graph error never escapes as an unhandled rejection and tears down
        // the TUI.
        if (owner) {
          // The account may have been removed while the modal was open.
          if (store.get().generationById[owner.id] === undefined) return
          void deleteChatById(
            session.clientFor(owner.id),
            accountStoreFor(store, owner),
            modal.chatId,
          ).catch(() => {})
          return
        }
        const acc = accountStore(store)
        if (modal.kind === 'confirm-delete-chat') {
          void deleteChatById(session.client(), acc, modal.chatId).catch(() => {})
        } else if (modal.kind === 'confirm-delete') {
          void deleteChatMessageById(session.client(), acc, modal.chatId, modal.messageId).catch(
            () => {},
          )
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
      borderStyle={inkBorder(theme.borders.modal)}
      borderColor={theme.borderActive}
      backgroundColor={modalBg(theme)}
      paddingX={theme.layout.modalPaddingX}
      paddingY={theme.layout.modalPaddingY}
    >
      <Text bold={theme.emphasis.modalTitleBold}>
        {isChat ? 'Delete chat?' : 'Delete message?'}
        {/* Several accounts open: the account the delete acts on. */}
        {labelSuffix(modal.kind === 'confirm-delete-chat' ? (modal.alias ?? label) : label)}
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
