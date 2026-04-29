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
import { buildSelectableList, clampCursor, itemMatchesFilter } from '../state/selectables'
import { ChatList } from './ChatList'
import { Composer } from './Composer'
import { MessagePane } from './MessagePane'
import { usePollerHandleRef } from './PollerContext'
import { StatusBar } from './StatusBar'
import { useAppState, useAppStore } from './StoreContext'
import { warn } from '../log'

const LIST_PANE_WIDTH = 30

export function App() {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const store = useAppStore()
  const pollerRef = usePollerHandleRef()
  const conn = useAppState((s) => s.conn)
  const focus = useAppState((s) => s.focus)
  const cursor = useAppState((s) => s.cursor)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const me = useAppState((s) => s.me)
  const inputZone = useAppState((s) => s.inputZone)
  const filter = useAppState((s) => s.filter)

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

      // From any non-list focus (and non-composer input zone), Esc returns
      // to the list view. (Composer handles its own Esc to leave compose
      // mode without changing focus.)
      if (focus.kind !== 'list' && key.escape) {
        store.set({ focus: { kind: 'list' }, inputZone: 'list' })
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
