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
import { createOneOnOneChat, getChat, searchChatUsers } from '../graph/chats'
import { GraphError } from '../graph/client'
import { buildSelectableList, clampCursor, itemMatchesFilter } from '../state/selectables'
import {
  focusKey,
  moveMessageCursor as nextMessageCursor,
  setMessageCursor as setStoredMessageCursor,
  type Focus,
} from '../state/store'
import { AccountsModal } from './AccountsModal'
import { ChatList } from './ChatList'
import { isNewChatQueryCandidate } from './ChatList'
import { Composer } from './Composer'
import { DiagnosticsModal } from './DiagnosticsModal'
import { HeaderBar } from './HeaderBar'
import { KeybindsModal, openKeybinds } from './KeybindsModal'
import { MenuModal, openMenu } from './MenuModal'
import { MessagePane } from './MessagePane'
import { readMessagePageState, type LoadMoreState } from './messageRows'
import { usePollerHandleRef } from './PollerContext'
import { StatusBar } from './StatusBar'
import { useAppState, useAppStore } from './StoreContext'
import { warn } from '../log'
import type { Chat, DirectoryUser } from '../types'

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
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const messageCacheByConvo = useAppState((s) => s.messageCacheByConvo)
  const messageCursorByConvo = useAppState((s) => s.messageCursorByConvo)
  const [newChatPrompt, setNewChatPrompt] = useState<string | null>(null)

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
          chats: s.chats.map((c) => (c.id === chatId ? { ...c, members: full.members } : c)),
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

  useEffect(() => {
    const conv = focusKey(focus)
    if (!conv) return
    const count = messagesByConvo[conv]?.length ?? 0
    if (count === 0) return
    store.set((s) => {
      const existing = s.messageCursorByConvo[conv]
      const next = existing === undefined ? count - 1 : clampCursor(existing, count)
      if (existing === next) return {}
      return {
        messageCursorByConvo: {
          ...s.messageCursorByConvo,
          [conv]: next,
        },
      }
    })
  }, [focus, messagesByConvo, store])

  const activeConv = focusKey(focus)
  const activeMessages = activeConv ? (messagesByConvo[activeConv] ?? []) : []
  const activeCache = activeConv ? messageCacheByConvo[activeConv] : undefined
  const activeMessageCursor =
    activeConv && activeMessages.length > 0
      ? clampCursor(
          messageCursorByConvo[activeConv] ?? activeMessages.length - 1,
          activeMessages.length,
        )
      : 0
  const focusedMessageId = activeMessages[activeMessageCursor]?.id
  const pageState = readMessagePageState(activeCache ?? activeMessages)
  const loadOlderState: LoadMoreState = pageState.loading
    ? 'loading'
    : pageState.error
      ? 'error'
      : pageState.hasOlder
        ? 'idle'
        : 'unavailable'

  function setMessageCursor(next: number): void {
    if (!activeConv || activeMessages.length === 0) return
    store.set((s) => ({
      messageCursorByConvo: setStoredMessageCursor(
        s.messageCursorByConvo,
        activeConv,
        next,
        activeMessages.length,
      ),
    }))
  }

  function moveMessageCursor(delta: number): void {
    if (!activeConv || activeMessages.length === 0) return
    store.set((s) => ({
      messageCursorByConvo: setStoredMessageCursor(
        s.messageCursorByConvo,
        activeConv,
        nextMessageCursor(s.messageCursorByConvo[activeConv], delta, activeMessages.length),
        activeMessages.length,
      ),
    }))
  }

  function jumpMessageBottom(): void {
    setMessageCursor(activeMessages.length - 1)
  }

  function tryLoadOlder(): void {
    if (loadOlderState !== 'idle') return
    const handle = pollerRef.current as
      | (typeof pollerRef.current & { loadOlderMessages?: (focus: Focus) => void | Promise<void> })
      | null
    void handle?.loadOlderMessages?.(focus)
  }

  function openNewChatPrompt(query = ''): void {
    setNewChatPrompt(query)
    store.set({ inputZone: 'menu' })
  }

  function closeNewChatPrompt(): void {
    setNewChatPrompt(null)
    store.set({ inputZone: 'list' })
  }

  async function createOrFocusChat(user: DirectoryUser): Promise<void> {
    const selfId = store.get().me?.id
    if (!selfId) throw new Error('Cannot create chat before /me is loaded')
    const existing = findExistingOneOnOne(store.get().chats, user.id, selfId)
    if (existing) {
      setNewChatPrompt(null)
      store.set({ focus: { kind: 'chat', chatId: existing.id }, inputZone: 'list', filter: '' })
      pollerRef.current?.refresh()
      return
    }
    const chat = await createOneOnOneChat(selfId, user.id)
    setNewChatPrompt(null)
    store.set((s) => ({
      chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)],
      focus: { kind: 'chat', chatId: chat.id },
      inputZone: 'list',
      filter: '',
    }))
    pollerRef.current?.refresh()
  }

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
        const syntheticNewChatQuery =
          filter && visible.length === 0 && isNewChatQueryCandidate(filter) ? filter.trim() : null
        const selectableCount = visible.length + (syntheticNewChatQuery ? 1 : 0)
        if (input === 'N') {
          openNewChatPrompt(filter)
          return
        }
        if (selectableCount === 0) return
        const safe = clampCursor(cursor, selectableCount)
        if (input === 'j' || input === 'J' || key.downArrow) {
          store.set({ cursor: clampCursor(safe + 1, selectableCount) })
          return
        }
        if (input === 'k' || input === 'K' || key.upArrow) {
          store.set({ cursor: clampCursor(safe - 1, selectableCount) })
          return
        }
        if (input === 'h' || input === 'H' || key.leftArrow) {
          return
        }
        if (key.return || input === 'l' || input === 'L' || key.rightArrow) {
          if (syntheticNewChatQuery && safe === visible.length) {
            openNewChatPrompt(syntheticNewChatQuery)
            return
          }
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

      if (focus.kind !== 'list') {
        if (input === 'h' || input === 'H' || key.leftArrow) {
          store.set({ focus: { kind: 'list' }, inputZone: 'list' })
          return
        }
        if (input === 'j' || input === 'J' || key.downArrow) {
          moveMessageCursor(1)
          return
        }
        if (input === 'k' || input === 'K' || key.upArrow) {
          moveMessageCursor(-1)
          return
        }
        if (input === 'u' || input === 'U' || (key as typeof key & { pageUp?: boolean }).pageUp) {
          moveMessageCursor(-Math.ceil(20 / 2))
          return
        }
        if (
          input === 'd' ||
          input === 'D' ||
          (key as typeof key & { pageDown?: boolean }).pageDown
        ) {
          moveMessageCursor(Math.ceil(20 / 2))
          return
        }
        if (input === 'l' || input === 'L' || key.rightArrow) {
          if (activeMessageCursor === 0) tryLoadOlder()
          else jumpMessageBottom()
          return
        }
        if (key.return && activeMessageCursor === 0) {
          tryLoadOlder()
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
        const trimmed = filter.trim()
        if (isNewChatQueryCandidate(trimmed)) {
          const items = buildSelectableList({ me, chats, teams, channelsByTeam })
          const visible = items.filter((it) => itemMatchesFilter(it, trimmed))
          if (visible.length === 0) {
            openNewChatPrompt(trimmed)
            return
          }
        }
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
        <HeaderBar />
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box width={LIST_PANE_WIDTH} flexShrink={0} borderStyle="round" borderColor="gray">
          <ChatList />
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} borderStyle="round" borderColor="gray">
          {newChatPrompt !== null ? (
            <NewChatPrompt
              initialQuery={newChatPrompt}
              onClose={closeNewChatPrompt}
              onSelectUser={createOrFocusChat}
            />
          ) : modal ? (
            modal.kind === 'menu' ? (
              <MenuModal />
            ) : modal.kind === 'keybinds' ? (
              <KeybindsModal />
            ) : modal.kind === 'accounts' ? (
              <AccountsModal />
            ) : (
              <DiagnosticsModal />
            )
          ) : (
            <MessagePane
              focusedMessageId={focusedMessageId}
              focusIndicatorActive={focus.kind !== 'list' && inputZone === 'list'}
              loadOlderState={loadOlderState}
            />
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

function NewChatPrompt(props: {
  initialQuery: string
  onClose: () => void
  onSelectUser: (user: DirectoryUser) => Promise<void>
}) {
  const { exit } = useApp()
  const [query, setQuery] = useState(props.initialQuery)
  const [results, setResults] = useState<DirectoryUser[]>([])
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!isNewChatQueryCandidate(q)) {
      setResults([])
      setCursor(0)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      setError(null)
      searchChatUsers(q, { top: 5, signal: ctrl.signal })
        .then((users) => {
          setResults(users)
          setCursor(0)
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return
          setError(err instanceof Error ? err.message : 'search failed')
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [query])

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onClose()
        return
      }
      if (key.ctrl && input === 'c') {
        exit()
        return
      }
      if (input === 'j' || input === 'J' || key.downArrow) {
        setCursor((c) => clampCursor(c + 1, results.length))
        return
      }
      if (input === 'k' || input === 'K' || key.upArrow) {
        setCursor((c) => clampCursor(c - 1, results.length))
        return
      }
      if (key.return) {
        const selected = results[clampCursor(cursor, results.length)]
        if (!selected || loading) return
        setLoading(true)
        setError(null)
        props.onSelectUser(selected).catch((err) => {
          setError(err instanceof Error ? err.message : 'create chat failed')
          setLoading(false)
        })
        return
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input)
      }
    },
    { isActive: true },
  )

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={3} paddingY={1}>
        <Text bold>New chat</Text>
        <Box height={1} />
        <Text>
          <Text color="gray">To: </Text>
          {query}
          <Text color="cyan">█</Text>
        </Text>
        {loading && <Text color="gray">Searching...</Text>}
        {error && <Text color="red">{error.slice(0, 120)}</Text>}
        {!loading && !error && results.length === 0 && query.trim() && (
          <Text color="gray">No matches</Text>
        )}
        {results.map((user, i) => {
          const selected = i === clampCursor(cursor, results.length)
          const detail = user.mail ?? user.userPrincipalName ?? user.id
          return (
            <Text key={user.id} color={selected ? 'cyan' : undefined} bold={selected}>
              {selected ? '> ' : '  '}
              {user.displayName ?? detail}
              <Text color="gray">{`  ${detail}`}</Text>
            </Text>
          )
        })}
        <Box height={1} />
        <Text color="gray">Enter opens selected 1:1 chat · Esc closes</Text>
      </Box>
    </Box>
  )
}

function findExistingOneOnOne(chats: Chat[], otherUserId: string, selfUserId: string): Chat | null {
  for (const chat of chats) {
    if (chat.chatType !== 'oneOnOne') continue
    const members = chat.members ?? []
    const hasSelf = members.some((m) => m.userId === selfUserId)
    const hasOther = members.some((m) => m.userId === otherUserId)
    if (hasSelf && hasOther) return chat
  }
  return null
}
