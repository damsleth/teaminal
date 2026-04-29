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

import { Box, Text, useApp, useInput, useStdin } from 'ink'
import { useEffect, useState } from 'react'
import { getChat } from '../graph/chats'
import { GraphError } from '../graph/client'
import { buildSelectableList, clampCursor } from '../state/selectables'
import { ChatList } from './ChatList'
import { Composer } from './Composer'
import { MessagePane } from './MessagePane'
import { StatusBar } from './StatusBar'
import { useAppState, useAppStore } from './StoreContext'
import { warn } from '../log'

const LIST_PANE_WIDTH = 30

export function App() {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const store = useAppStore()
  const conn = useAppState((s) => s.conn)
  const focus = useAppState((s) => s.focus)
  const cursor = useAppState((s) => s.cursor)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const me = useAppState((s) => s.me)

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

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        exit()
        return
      }

      // List-focus navigation (cursor + open).
      if (focus.kind === 'list') {
        if (input === 'q') {
          exit()
          return
        }
        const items = buildSelectableList({
          me,
          chats,
          teams,
          channelsByTeam,
          cursor,
          focus,
          messagesByConvo: {},
          memberPresence: {},
          conn,
        })
        if (items.length === 0) return
        const safe = clampCursor(cursor, items.length)
        if (input === 'j' || key.downArrow) {
          store.set({ cursor: clampCursor(safe + 1, items.length) })
          return
        }
        if (input === 'k' || key.upArrow) {
          store.set({ cursor: clampCursor(safe - 1, items.length) })
          return
        }
        if (key.return) {
          const it = items[safe]
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

      // From any non-list focus, Esc returns to the list view.
      if (focus.kind !== 'list' && key.escape) {
        store.set({ focus: { kind: 'list' } })
      }
    },
    { isActive: isRawModeSupported },
  )

  return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold>teaminal</Text>
        <Text color="gray">{`  conn: ${conn}`}</Text>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box width={LIST_PANE_WIDTH} borderStyle="round" borderColor="gray">
          <ChatList />
        </Box>
        <Box flexGrow={1} borderStyle="round" borderColor="gray">
          <MessagePane />
        </Box>
      </Box>
      <Box borderStyle="round" borderColor="gray">
        <Composer />
      </Box>
      <StatusBar />
    </Box>
  )
}
