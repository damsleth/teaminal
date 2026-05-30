// Edit-reactions overlay for the focused chat message.
//
// Opened by the chat-zone `t` key (when a chat message is focused).
// Lists the current user's reactions on the message; j/k move the
// cursor, x / Enter removes the selected reaction, Esc closes.
// Mirrors ConfirmDeleteModal / ReactionPickerModal in structure and theming.

import { Box, Text, useApp, useInput } from 'ink'
import { useState } from 'react'
import { toggleReaction } from '../state/chatActions'
import { ownReactionTypes } from '../state/messageMutations'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { reactionGlyph } from './reactions'

export function EditReactionsModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const me = useAppState((s) => s.me)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const theme = useTheme()
  const isOpen = modal?.kind === 'edit-reactions'

  const [cursor, setCursor] = useState(0)

  // Derive the message and user's reactions when the modal is open.
  const message =
    isOpen && modal.kind === 'edit-reactions'
      ? (messagesByConvo[`chat:${modal.chatId}`] ?? []).find((m) => m.id === modal.messageId)
      : undefined

  const myReactionTypes: string[] = isOpen && message && me ? ownReactionTypes(message, me.id) : []

  useInput(
    (input, key) => {
      if (!isOpen || modal.kind !== 'edit-reactions') return
      if (key.ctrl && input.toLowerCase() === 'c') {
        exit()
        return
      }
      if (key.escape) {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      const ch = input.toLowerCase()
      if (ch === 'j' || key.downArrow) {
        if (myReactionTypes.length > 0) {
          setCursor((c) => Math.min(myReactionTypes.length - 1, c + 1))
        }
        return
      }
      if (ch === 'k' || key.upArrow) {
        if (myReactionTypes.length > 0) {
          setCursor((c) => Math.max(0, c - 1))
        }
        return
      }
      if ((ch === 'x' || key.return) && myReactionTypes.length > 0) {
        const type = myReactionTypes[cursor]
        if (!type || !me) return
        const { chatId, messageId } = modal
        // If removing the last reaction, close the modal.
        if (myReactionTypes.length === 1) {
          store.set({ modal: null, inputZone: 'list' })
        } else {
          // Move cursor up if it was at the end.
          setCursor((c) => Math.min(myReactionTypes.length - 2, c))
        }
        void toggleReaction(store, chatId, messageId, type, me).catch(() => {})
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen || modal.kind !== 'edit-reactions') return null

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borders.modal}
      borderColor={theme.borderActive}
      backgroundColor={theme.background}
      paddingX={theme.layout.modalPaddingX}
      paddingY={theme.layout.modalPaddingY}
    >
      <Text bold={theme.emphasis.modalTitleBold}>Your reactions</Text>
      {myReactionTypes.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.mutedText}>no reactions to edit</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {myReactionTypes.map((type, i) => {
            const selected = i === cursor
            return (
              <Box key={type}>
                <Text color={selected ? theme.selected : theme.text}>
                  {selected ? '> ' : '  '}
                  {reactionGlyph(type)}
                  {'  '}
                  {type}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.mutedText}>
          {myReactionTypes.length > 0 ? 'j/k move · x / enter remove · esc close' : 'esc to close'}
        </Text>
      </Box>
    </Box>
  )
}
