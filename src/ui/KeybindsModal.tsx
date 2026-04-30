// Keybindings reference overlay.
//
// Triggered by '?' from the chat list (or by Help -> Keybindings in the
// menu). Esc closes and returns to the previous state. Read-only - no
// configuration here in v1.
//
// To add a keybind row, append to the BINDINGS table; columns are
// [key, when, action]. Group rows with a divider when sections grow.

import { Box, Text, useApp, useInput } from 'ink'
import { useAppState, useAppStore, useTheme } from './StoreContext'

type Binding = { keys: string; when: string; action: string }

const BINDINGS: Binding[] = [
  { keys: 'j / ↓', when: 'list', action: 'cursor down' },
  { keys: 'k / ↑', when: 'list', action: 'cursor up' },
  { keys: 'Enter', when: 'list', action: 'open chat / channel' },
  { keys: 'Tab', when: 'chat / channel', action: 'enter composer' },
  { keys: 'Esc', when: 'composer / filter', action: 'leave mode' },
  { keys: 'Esc', when: 'chat / channel', action: 'back to chat list' },
  { keys: 'Esc', when: 'chat list', action: 'open menu' },
  { keys: 'Enter', when: 'composer', action: 'send' },
  { keys: 'Ctrl+J', when: 'composer', action: 'newline' },
  { keys: '/', when: 'list', action: 'filter chats' },
  { keys: '?', when: 'list', action: 'show this help' },
  { keys: 'r', when: 'any', action: 'refresh now' },
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

  useInput(
    (input, key) => {
      if (key.escape || key.return) {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      if (key.ctrl && input === 'c') {
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
        borderStyle="round"
        borderColor={theme.borderActive}
        paddingX={3}
        paddingY={1}
      >
        <Text bold>Keybindings</Text>
        <Box height={1} />
        {BINDINGS.map((b, i) => (
          <Text key={i}>
            <Text color={theme.selected}>{b.keys.padEnd(keyW)}</Text>
            <Text color="gray">{b.when.padEnd(whenW)}</Text>
            <Text>{b.action}</Text>
          </Text>
        ))}
        <Box height={1} />
        <Text color="gray">esc / enter to close</Text>
      </Box>
    </Box>
  )
}
