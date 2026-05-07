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
  { keys: 'u/d', when: 'list', action: 'half-page sidebar' },
  { keys: 'l / Enter', when: 'list', action: 'open chat / channel' },
  { keys: 'h', when: 'list', action: 'reserved back/no-op' },
  { keys: 'n', when: 'list', action: 'new chat prompt' },
  { keys: 'j / ↓', when: 'chat / channel', action: 'focus next message' },
  { keys: 'k / ↑', when: 'chat / channel', action: 'focus previous / load older at top' },
  { keys: 'u/d', when: 'chat / channel', action: 'half-page messages; u loads older near top' },
  { keys: 'l', when: 'chat / channel', action: 'jump bottom' },
  { keys: 'h / Esc', when: 'chat / channel', action: 'back to chat list' },
  { keys: 't', when: 'channel', action: 'open thread for focused message' },
  { keys: 'h / Esc', when: 'thread', action: 'back to channel' },
  { keys: 'Tab', when: 'chat / channel', action: 'toggle composer' },
  { keys: 'Tab', when: 'composer', action: 'back to chat' },
  { keys: 'Esc', when: 'composer / filter', action: 'leave mode' },
  { keys: 'Esc', when: 'chat list', action: 'open menu' },
  { keys: 'Enter', when: 'composer', action: 'send' },
  { keys: 'Ctrl+J', when: 'composer', action: 'newline' },
  { keys: '← / →', when: 'composer', action: 'cursor left / right' },
  { keys: 'Ctrl+A / Ctrl+E', when: 'composer', action: 'line start / end' },
  { keys: 'Ctrl+W / M-Bksp', when: 'composer', action: 'delete previous word' },
  { keys: 'Ctrl+U / Ctrl+K', when: 'composer', action: 'delete to line start / end' },
  { keys: '/', when: 'list', action: 'filter chats' },
  { keys: '/', when: 'chat / channel', action: 'search messages' },
  { keys: 'n', when: 'search', action: 'next match' },
  { keys: 'Enter', when: 'search', action: 'jump to most recent match' },
  { keys: '?', when: 'list', action: 'show this help' },
  { keys: 'r', when: 'any', action: 'refresh now' },
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

  useInput(
    (input, key) => {
      const ch = input.toLowerCase()
      if (key.escape || key.return) {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
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
