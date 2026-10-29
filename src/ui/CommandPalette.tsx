// Command palette (Ctrl+P): type to filter every command — menu items and
// settings, chats and channels, key actions — then Enter runs the selected
// one. ↑/↓ (or Ctrl+N / Ctrl+P) move, PageUp/PageDown move half a page,
// Esc closes. Commands come from ./commands.

import { Box, Text, useApp, useStdout } from 'ink'
import { useState } from 'react'
import type { AppState, Store } from '../state/store'
import { buildCommands, filterCommands, type Command } from './commands'
import { runMenuItem } from './MenuModal'
import { useTerminalRows } from './hooks/useTerminalRows'
import { useSessionApi } from './SessionContext'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'

export function openCommandPalette(store: Store<AppState>): void {
  store.set({ modal: { kind: 'command-palette' }, inputZone: 'menu' })
}

export function CommandPalette(props: {
  // Key actions that live in App (new chat prompt, refresh, ...).
  keyActions: { id: string; title: string; keys: string; run: () => void }[]
}) {
  const { exit } = useApp()
  const store = useAppStore()
  const session = useSessionApi()
  const theme = useTheme()
  const rows = useTerminalRows()
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 80
  const isOpen = useAppState((s) => s.modal?.kind === 'command-palette')
  // The whole state while open (values beside settings stay current);
  // null while closed, so a closed palette doesn't re-render on every update.
  const state = useAppState((s) => (s.modal?.kind === 'command-palette' ? s : null))
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const close = () => store.set({ modal: null, inputZone: 'list' })
  const commands: Command[] = state
    ? buildCommands(state, {
        runMenuItem: (item, path) => runMenuItem(item, path, { store, session, exit }),
        focusChat: (chatId) => store.set({ focus: { kind: 'chat', chatId }, inputZone: 'list' }),
        focusChannel: (teamId, channelId) =>
          store.set({ focus: { kind: 'channel', teamId, channelId }, inputZone: 'list' }),
        keyActions: props.keyActions,
      })
    : []
  const matches = filterCommands(commands, query)
  const selected = Math.min(cursor, Math.max(0, matches.length - 1))
  const visibleRows = Math.max(5, rows - 12)

  useInput(
    (input, key) => {
      if (key.escape) {
        setQuery('')
        setCursor(0)
        close()
        return
      }
      if (key.return) {
        const command = matches[selected]
        if (!command) return
        setQuery('')
        setCursor(0)
        // Close first: a command may open its own modal.
        close()
        command.run()
        return
      }
      const half = Math.max(1, Math.floor(visibleRows / 2))
      const move = (delta: number) =>
        setCursor(Math.max(0, Math.min(matches.length - 1, selected + delta)))
      if (key.upArrow || (key.ctrl && input === 'p')) return move(-1)
      if (key.downArrow || (key.ctrl && input === 'n')) return move(1)
      if (key.pageUp) return move(-half)
      if (key.pageDown) return move(half)
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1))
        setCursor(0)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input)
        setCursor(0)
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  const bg = modalBg(theme)
  const width = Math.max(40, Math.min(100, columns - 8))
  const inner = width - 2 - 2 * theme.layout.modalPaddingX
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(visibleRows / 2), matches.length - visibleRows),
  )
  const shown = matches.slice(start, start + visibleRows)
  const fit = (text: string, w: number) =>
    text.length > w ? `${text.slice(0, Math.max(0, w - 1))}…` : text.padEnd(w)

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        width={width}
        borderStyle={inkBorder(theme.borders.modal)}
        borderColor={theme.borderActive}
        backgroundColor={bg}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
      >
        <Text backgroundColor={bg} bold={theme.emphasis.modalTitleBold}>
          {fit(`> ${query}█`, inner)}
        </Text>
        <Text color={theme.mutedText} backgroundColor={bg}>
          {fit(`${matches.length} of ${commands.length} · enter runs · esc closes`, inner)}
        </Text>
        {shown.map((command, i) => {
          const isSel = start + i === selected
          const right = command.detail ? `${command.detail} · ${command.group}` : command.group
          const titleW = Math.max(10, inner - right.length - 3)
          return (
            <Text
              key={command.id}
              backgroundColor={isSel ? (theme.selectedRowBackground ?? bg) : bg}
            >
              <Text
                color={isSel ? theme.selected : theme.text}
                bold={isSel && theme.emphasis.selectedBold}
              >
                {`${isSel ? '>' : ' '} ${fit(command.title, titleW)} `}
              </Text>
              <Text color={theme.mutedText}>{fit(right, inner - titleW - 3)}</Text>
            </Text>
          )
        })}
        {matches.length === 0 && (
          <Text color={theme.mutedText} backgroundColor={bg}>
            {fit('  no matching command', inner)}
          </Text>
        )}
      </Box>
    </Box>
  )
}
