// Keybindings reference overlay.
//
// Triggered by '?' from the chat list (or by Help -> Keybindings in the
// menu). Esc closes and returns to the previous state. j/k (↓/↑) and u/d
// scroll when the table is taller than the pane. Read-only - no
// configuration here in v1.
//
// To add a keybind row, append to the BINDINGS table; columns are
// [key, when, action]. Group rows with a divider when sections grow.

import { Box, Text, useApp } from 'ink'
import { useState } from 'react'
import { useTerminalRows } from './hooks/useTerminalRows'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'
import { useAppState, useAppStore, useTheme } from './StoreContext'

type Binding = { keys: string; when: string; action: string }

const BINDINGS: Binding[] = [
  { keys: 'j / ↓', when: 'list', action: 'cursor down' },
  { keys: 'k / ↑', when: 'list', action: 'cursor up' },
  { keys: 'u/d', when: 'list', action: 'half-page sidebar' },
  { keys: 'l / Enter', when: 'list', action: 'open chat / channel · expand section' },
  { keys: 'h / ←', when: 'list', action: 'collapse section (chat type / team / Teams)' },
  { keys: 'n', when: 'list', action: 'new chat prompt' },
  { keys: 'Ctrl+D', when: 'list / chat', action: 'delete chat (confirm y/n)' },
  { keys: 'Ctrl+B', when: 'list / chat', action: 'hide / show chat list (single pane)' },
  { keys: 'j / ↓', when: 'chat / channel', action: 'next message / attachment' },
  { keys: 'k / ↑', when: 'chat / channel', action: 'prev message / attachment / older' },
  { keys: 'Space', when: 'chat / channel', action: 'open focused image / link' },
  { keys: 'u/d', when: 'chat / channel', action: 'half-page messages' },
  { keys: 'gg / G', when: 'chat / channel', action: 'jump top / bottom' },
  { keys: 'space / l', when: 'channel', action: 'open focused reply badge (thread)' },
  { keys: 'h / ←', when: 'chat / channel', action: 'back to chat list' },
  { keys: 't', when: 'channel', action: 'open thread for focused message' },
  { keys: 'r', when: 'chat', action: 'react to focused message' },
  { keys: 'e', when: 'chat', action: 'edit own focused message' },
  { keys: 'x', when: 'chat', action: 'delete own focused message' },
  { keys: 'h / ←', when: 'thread', action: 'back to channel' },
  { keys: 'Tab', when: 'chat / channel', action: 'toggle composer' },
  { keys: 'Tab', when: 'composer', action: 'back to chat' },
  { keys: 'Esc', when: 'composer / filter', action: 'leave mode' },
  { keys: 'Esc', when: 'list / chat / channel', action: 'open menu' },
  { keys: 'Ctrl+O / Ctrl+T', when: 'menu', action: 'edit settings / theme file in $VISUAL' },
  { keys: 'Ctrl+Enter', when: 'composer', action: 'send (also Alt+Enter, Ctrl+J)' },
  { keys: 'Enter', when: 'composer', action: 'newline (swapped with send by enterSends)' },
  { keys: '← / →', when: 'composer', action: 'cursor left / right' },
  { keys: 'Ctrl+A / Ctrl+E', when: 'composer', action: 'line start / end' },
  { keys: 'Ctrl+W / M-Bksp', when: 'composer', action: 'delete previous word' },
  { keys: 'Ctrl+U / Ctrl+K', when: 'composer', action: 'delete to line start / end' },
  { keys: '/', when: 'list', action: 'filter chats' },
  { keys: '/', when: 'chat / channel', action: 'search messages (in conversation)' },
  { keys: 's', when: 'list / chat', action: 'search all messages (server-side)' },
  { keys: 'p', when: 'list / chat', action: 'find people / start a chat' },
  { keys: 'n', when: 'search', action: 'next match' },
  { keys: 'Enter', when: 'search', action: 'jump to most recent match' },
  { keys: '?', when: 'list', action: 'show this help' },
  { keys: 'r', when: 'list / channel', action: 'refresh now' },
  { keys: 'Shift+R', when: 'any', action: 'hard refresh' },
  { keys: 'q', when: 'list / menu', action: 'quit' },
  { keys: 'Ctrl+C', when: 'any', action: 'quit' },
]

export function openKeybinds(store: ReturnType<typeof useAppStore>): void {
  store.set({ modal: { kind: 'keybinds' }, inputZone: 'menu' })
}

export function KeybindsModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const theme = useTheme()
  const isOpen = modal?.kind === 'keybinds'
  const termRows = useTerminalRows()
  const [offset, setOffset] = useState(0)
  // ponytail: the overlay sits in the message pane; header, composer, status
  // bar and pane border take ~9 rows, the modal's own chrome 6 + paddingY.
  const capacity = Math.max(3, termRows - 15 - 2 * theme.layout.modalPaddingY)
  const maxOffset = Math.max(0, BINDINGS.length - capacity)
  const top = Math.min(offset, maxOffset)
  const scrollBy = (delta: number) => setOffset(Math.max(0, Math.min(maxOffset, top + delta)))

  useInput(
    (input, key) => {
      const ch = input.toLowerCase()
      if (key.escape || key.return) {
        setOffset(0)
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      if (ch === 'j' || key.downArrow) return scrollBy(1)
      if (ch === 'k' || key.upArrow) return scrollBy(-1)
      if (ch === 'd' || key.pageDown) return scrollBy(Math.ceil(capacity / 2))
      if (ch === 'u' || key.pageUp) return scrollBy(-Math.ceil(capacity / 2))
      if (key.ctrl && ch === 'c') {
        exit()
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  // Column widths sized to the longest entry plus padding.
  const keyW = Math.max(...BINDINGS.map((b) => b.keys.length)) + 2
  const whenW = Math.max(...BINDINGS.map((b) => b.when.length)) + 2

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={inkBorder(theme.borders.modal)}
        borderColor={theme.borderActive}
        backgroundColor={modalBg(theme)}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
        width={80}
        maxWidth="100%"
      >
        <Text bold={theme.emphasis.modalTitleBold}>Keybindings</Text>
        <Box height={1} />
        {BINDINGS.slice(top, top + capacity).map((b, i) => (
          <Text key={top + i} wrap="truncate-end">
            <Text color={theme.selected}>{b.keys.padEnd(keyW)}</Text>
            <Text color="gray">{b.when.padEnd(whenW)}</Text>
            <Text>{b.action}</Text>
          </Text>
        ))}
        <Box height={1} />
        <Text color="gray" wrap="truncate-end">
          {maxOffset > 0
            ? `${top + 1}-${Math.min(top + capacity, BINDINGS.length)} of ${BINDINGS.length} · j/k u/d scroll · esc / enter to close`
            : 'esc / enter to close'}
        </Text>
      </Box>
    </Box>
  )
}
