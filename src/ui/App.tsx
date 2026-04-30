// Top-level layout + global keybinds + focus management.
//
// Three-pane shell:
//
//   ┌─────────────┬───────────────────────────────┐
//   │  ChatList   │  MessagePane                  │
//   │             │                               │
//   ├─────────────┴───────────────────────────────┤
//   │  Composer                                   │
//   ├─────────────────────────────────────────────┤
//   │  StatusBar                                  │
//   └─────────────────────────────────────────────┘
//
// Global keybinds:
//   q / Ctrl+C       quit
//   j / down         cursor down (when focus is list)
//   k / up           cursor up   (when focus is list)
//   Enter            open the item under the cursor
//   Esc              return to list focus
//
// Composer keybinds (step 11) and refresh / filter (step 15) land later.

import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import { useEffect, useState } from 'react'
import { getChat } from '../graph/chats'
import { GraphError } from '../graph/client'
import { buildSelectableList, clampCursor, itemMatchesFilter } from '../state/selectables'
import { ChatList } from './ChatList'
import { Composer } from './Composer'
import { DiagnosticsModal } from './DiagnosticsModal'
import { KeybindsModal, openKeybinds } from './KeybindsModal'
import { MenuModal, openMenu } from './MenuModal'
import { MessagePane } from './MessagePane'
import { usePollerHandleRef } from './PollerContext'
import { StatusBar } from './StatusBar'
import { useAppState, useAppStore } from './StoreContext'
import { warn } from '../log'

const LIST_PANE_WIDTH = 30

export function App() {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const { stdout } = useStdout()
  const store = useAppStore()
  const pollerRef = usePollerHandleRef()

  // Track real terminal rows. Ink's height="100%" resolves against the
  // intrinsic content height, not the terminal, so it lets the layout
  // shrink/grow with content (e.g. switching between chats with different
  // message counts visibly jumps the box). Setting an explicit row count
  // pins the layout. When the user picks 'full', use stdout.rows and
  // re-render on resize.
  const [terminalRows, setTerminalRows] = useState<number>(stdout?.rows ?? 24)
  useEffect(() => {
    if (!stdout) return
    const onResize = () => setTerminalRows(stdout.rows ?? 24)
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  const conn = useAppState((s) => s.conn)
  const focus = useAppState((s) => s.focus)
  const cursor = useAppState((s) => s.cursor)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const me = useAppState((s) => s.me)
  const inputZone = useAppState((s) => s.inputZone)
  const filter = useAppState((s) => s.filter)
  const modal = useAppState((s) => s.modal)
  const windowHeight = useAppState((s) => s.settings.windowHeight)

  // Hydrate members for the focused chat once - they make the header label
  // useful for 1:1 chats with no topic.
  const [hydrated, setHydrated] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (focus.kind !== 'chat') return
    const chatId = focus.chatId
    if (hydrated.has(chatId)) return
    const existing = store.get().chats.find((c) => c.id === chatId)
    if (existing?.members && existing.members.length > 0) {
      setHydrated((s) => new Set(s).add(chatId))
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const full = await getChat(chatId, { members: true })
        if (cancelled) return
        store.set((s) => ({
          chats: s.chats.map((c) =>
            c.id === chatId ? { ...c, members: full.members } : c,
          ),
        }))
        setHydrated((s) => new Set(s).add(chatId))
      } catch (err) {
        if (cancelled) return
        if (err instanceof GraphError) {
          warn(`hydrate members ${chatId}:`, err.message)
        } else {
          warn(`hydrate members ${chatId}:`, String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [focus, hydrated, store])

  // App's global useInput owns list-mode keys; Composer's own useInput
  // handles composer-mode keys; the filter useInput below handles
  // chat-list filtering. All three are mutually exclusive via isActive
  // gates so a single keystroke is never delivered twice.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        exit()
        return
      }

      // Tab moves into the composer when there's an open chat/channel.
      if (key.tab && focus.kind !== 'list') {
        store.set({ inputZone: 'composer' })
        return
      }

      // r forces an immediate refresh of the active conv + chat list.
      if (input === 'r') {
        pollerRef.current?.refresh()
        return
      }

      // / enters filter mode when in list focus. Useful when the chat list
      // is long; filter applies to the chat label, team name, and channel
      // displayName via case-insensitive substring match.
      if (focus.kind === 'list' && input === '/') {
        store.set({ inputZone: 'filter' })
        return
      }

      // ? opens the keybindings reference (any focus, list inputZone).
      if (input === '?') {
        openKeybinds(store)
        return
      }

      // List-focus navigation (cursor + open).
      if (focus.kind === 'list') {
        if (input === 'q') {
          exit()
          return
        }
        const items = buildSelectableList({ me, chats, teams, channelsByTeam })
        const visible = filter ? items.filter((it) => itemMatchesFilter(it, filter)) : items
        if (visible.length === 0) return
        const safe = clampCursor(cursor, visible.length)
        if (input === 'j' || key.downArrow) {
          store.set({ cursor: clampCursor(safe + 1, visible.length) })
          return
        }
        if (input === 'k' || key.upArrow) {
          store.set({ cursor: clampCursor(safe - 1, visible.length) })
          return
        }
        if (key.return) {
          const it = visible[safe]
          if (!it) return
          if (it.kind === 'chat') {
            store.set({ focus: { kind: 'chat', chatId: it.chat.id } })
          } else if (it.kind === 'channel') {
            store.set({
              focus: { kind: 'channel', teamId: it.team.id, channelId: it.channel.id },
            })
          }
          // team selection is a no-op in v1 (no team-detail view yet)
          return
        }
      }

      // Esc behavior depends on what's open:
      //   - chat/channel focused: leave it, return to chat list
      //   - already at chat list: open the modal pause-menu
      // Composer/filter handle their own Esc.
      if (key.escape) {
        if (focus.kind !== 'list') {
          store.set({ focus: { kind: 'list' }, inputZone: 'list' })
        } else {
          openMenu(store)
        }
        return
      }
    },
    { isActive: isRawModeSupported && inputZone === 'list' },
  )

  // Filter-mode keys: typing builds the filter buffer, Backspace deletes,
  // Esc clears + exits filter mode, Enter accepts and exits but keeps
  // the filter applied so the user can navigate the filtered list.
  useInput(
    (input, key) => {
      if (key.escape) {
        store.set({ filter: '', inputZone: 'list', cursor: 0 })
        return
      }
      if (key.return) {
        store.set({ inputZone: 'list', cursor: 0 })
        return
      }
      if (key.backspace || key.delete) {
        store.set({ filter: filter.slice(0, -1) })
        return
      }
      if (input && !key.ctrl && !key.meta) {
        store.set({ filter: filter + input })
      }
    },
    { isActive: isRawModeSupported && inputZone === 'filter' },
  )

  // Modal rendering: header / composer / status bar stay visible; the
  // central row (ChatList + MessagePane) is replaced by the modal box.
  // Ink has no z-index so this is the closest "overlay" we can do.
  //
  // windowHeight: 0 means "fill the terminal" - we resolve to the live
  // stdout.rows count so the layout pins to terminal height (height="100%"
  // shrinks with content, which makes the box jump when switching between
  // chats with different message counts). Any other value is an explicit
  // row count, useful when the user wants to keep prior terminal
  // scrollback visible above the app.
  const heightProp: number = windowHeight > 0 ? windowHeight : terminalRows

  return (
    <Box flexDirection="column" height={heightProp}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold>teaminal</Text>
        <Text color="gray">{`  conn: ${conn}`}</Text>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box
          width={LIST_PANE_WIDTH}
          flexShrink={0}
          borderStyle="round"
          borderColor="gray"
        >
          <ChatList />
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} borderStyle="round" borderColor="gray">
          {modal ? (
            modal.kind === 'menu' ? (
              <MenuModal />
            ) : modal.kind === 'keybinds' ? (
              <KeybindsModal />
            ) : (
              <DiagnosticsModal />
            )
          ) : (
            <MessagePane />
          )}
        </Box>
      </Box>
      <Box borderStyle="round" borderColor="gray">
        <Composer />
      </Box>
      <StatusBar />
    </Box>
  )
}
