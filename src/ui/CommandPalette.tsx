// Command palette (Ctrl+P): type to filter every command — menu items and
// settings, chats and channels, key actions — then Enter runs the selected
// one. ↑/↓ (or Ctrl+N / Ctrl+P) move, PageUp/PageDown move half a page,
// Esc closes and returns to where it was opened. Commands come from
// ./commands.

import { Box, Text, useApp, useStdout, type DOMElement } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, Store } from '../state/store'
import { buildCommands, filterCommands, type Command, type CommandRunners } from './commands'
import { elementRect } from './inlineImageLayout'
import { runMenuItem } from './MenuModal'
import { useSessionApi } from './SessionContext'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'

export function openCommandPalette(store: Store<AppState>): void {
  const returnTo = store.get().inputZone
  store.set({ modal: { kind: 'command-palette', returnTo }, inputZone: 'menu' })
}

const segmenter = new Intl.Segmenter()

// `text` cut or padded to exactly `width` terminal cells (wide characters
// count double; graphemes are never split).
export function fitCells(text: string, width: number): string {
  if (width <= 0) return ''
  if (Bun.stringWidth(text) <= width) return text + ' '.repeat(width - Bun.stringWidth(text))
  let out = ''
  let used = 0
  for (const { segment } of segmenter.segment(text)) {
    const w = Bun.stringWidth(segment)
    if (used + w > width - 1) break
    out += segment
    used += w
  }
  return `${out}…${' '.repeat(Math.max(0, width - 1 - used))}`
}

type KeyAction = CommandRunners['keyActions'][number]

export function CommandPalette(props: {
  // Key actions that live in App (new chat prompt, refresh, ...).
  keyActions: KeyAction[]
}) {
  const { exit } = useApp()
  const store = useAppStore()
  const session = useSessionApi()
  const theme = useTheme()
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 80
  const modal = useAppState((s) => (s.modal?.kind === 'command-palette' ? s.modal : null))
  const isOpen = modal !== null
  // Only what the commands are built from, so unrelated updates (presence,
  // polling of message bodies) don't rebuild them.
  const settings = useAppState((s) => s.settings)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const nameByUserId = useAppState((s) => s.nameByUserId)
  const me = useAppState((s) => s.me)
  const [query, setQuery] = useState('')
  // The selection follows a command, not a position, so a chat moving in
  // the list while the palette is open can't change what Enter runs.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Key actions are rebuilt by App on every render; read the latest here.
  const keyActions = useRef(props.keyActions)
  keyActions.current = props.keyActions

  const baseCommands = useMemo(
    () =>
      isOpen
        ? buildCommands({ settings, chats, teams, channelsByTeam, nameByUserId, me } as AppState, {
            runMenuItem: (item, path) => runMenuItem(item, path, { store, session, exit }),
            focusChat: (chatId) =>
              store.set({ focus: { kind: 'chat', chatId }, inputZone: 'list' }),
            focusChannel: (teamId, channelId) =>
              store.set({ focus: { kind: 'channel', teamId, channelId }, inputZone: 'list' }),
            keyActions: [],
          })
        : [],
    [isOpen, settings, chats, teams, channelsByTeam, nameByUserId, me, store, session, exit],
  )
  const commands: Command[] = useMemo(
    () => [
      ...props.keyActions.map((a) => ({
        id: `key:${a.id}`,
        title: a.title,
        group: 'Keys',
        detail: a.keys,
        run: () => keyActions.current.find((k) => k.id === a.id)?.run(),
      })),
      ...baseCommands,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- titles only; runs read the ref
    [baseCommands, props.keyActions.map((a) => a.id + a.title).join('|')],
  )
  const matches = useMemo(() => filterCommands(commands, query), [commands, query])
  const found = selectedId ? matches.findIndex((c) => c.id === selectedId) : -1
  const selected = found === -1 ? 0 : found

  // The overlay's measured height decides how many rows fit.
  const rootRef = useRef<DOMElement>(null)
  const [overlayRows, setOverlayRows] = useState(20)
  useEffect(() => {
    if (!rootRef.current) return
    const h = Math.round(elementRect(rootRef.current).height)
    if (h > 0 && h !== overlayRows) setOverlayRows(h)
  })
  const chromeRows = 2 + 2 * theme.layout.modalPaddingY + 2
  const visibleRows = Math.max(3, overlayRows - chromeRows)

  const reset = () => {
    setQuery('')
    setSelectedId(null)
  }

  useInput(
    (input, key) => {
      if (key.escape) {
        reset()
        store.set({ modal: null, inputZone: modal?.returnTo ?? 'list' })
        return
      }
      if (key.return) {
        const command = matches[selected]
        if (!command) return
        reset()
        // Close first: a command may open its own modal or move focus.
        store.set({ modal: null, inputZone: 'list' })
        command.run()
        return
      }
      const half = Math.max(1, Math.floor(visibleRows / 2))
      const move = (delta: number) => {
        const next = matches[Math.max(0, Math.min(matches.length - 1, selected + delta))]
        if (next) setSelectedId(next.id)
      }
      if (key.upArrow || (key.ctrl && input === 'p')) return move(-1)
      if (key.downArrow || (key.ctrl && input === 'n')) return move(1)
      if (key.pageUp) return move(-half)
      if (key.pageDown) return move(half)
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1))
        setSelectedId(null)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input)
        setSelectedId(null)
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

  return (
    <Box ref={rootRef} alignItems="center" justifyContent="center" flexGrow={1} width="100%">
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
          {fitCells(`> ${query}█`, inner)}
        </Text>
        <Text color={theme.mutedText} backgroundColor={bg}>
          {fitCells(`${matches.length} of ${commands.length} · enter runs · esc closes`, inner)}
        </Text>
        {shown.map((command, i) => {
          const isSel = start + i === selected
          const right = command.detail ? `${command.detail} · ${command.group}` : command.group
          const rightW = Math.min(Bun.stringWidth(right), Math.floor(inner / 2))
          const titleW = Math.max(10, inner - rightW - 3)
          return (
            <Text
              key={command.id}
              backgroundColor={isSel ? (theme.selectedRowBackground ?? bg) : bg}
            >
              <Text
                color={isSel ? theme.selected : theme.text}
                bold={isSel && theme.emphasis.selectedBold}
              >
                {`${isSel ? '>' : ' '} ${fitCells(command.title, titleW)} `}
              </Text>
              <Text color={theme.mutedText}>{fitCells(right, inner - titleW - 3)}</Text>
            </Text>
          )
        })}
        {matches.length === 0 && (
          <Text color={theme.mutedText} backgroundColor={bg}>
            {fitCells('  no matching command', inner)}
          </Text>
        )}
      </Box>
    </Box>
  )
}
