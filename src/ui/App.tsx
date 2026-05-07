// Top-level layout + keybind dispatch + focus management.
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
// This file is intentionally thin. Per-feature work lives in:
//   src/ui/keybinds/    zone keymaps (list / chat / filter)
//   src/ui/hooks/       focus-driven side-effect hooks
//   src/ui/derive.ts    pure helpers (e.g. findExistingOneOnOne)
//   src/ui/NewChatPrompt.tsx
//
// Composer keys live inside <Composer/>; modal keys live inside the
// individual modal components. The dispatcher below only routes the
// list / chat / filter zones plus a few app-wide shortcuts.

import { Box, useApp, useInput, useStdin } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { createOneOnOneChat, getChat } from '../graph/chats'
import { resolveFederatedEquivalentConversationId } from '../graph/teamsFederation'
import { recordEvent } from '../log'
import { clampCursor } from '../state/selectables'
import {
  focusKey,
  moveMessageCursor as nextMessageCursor,
  setMessageCursor as setStoredMessageCursor,
  type Focus,
} from '../state/store'
import { AccountsModal } from './AccountsModal'
import { ChatList } from './ChatList'
import { Composer } from './Composer'
import { DiagnosticsModal } from './DiagnosticsModal'
import { EventsModal } from './EventsModal'
import { HeaderBar } from './HeaderBar'
import { KeybindsModal } from './KeybindsModal'
import { MenuModal } from './MenuModal'
import { MessagePane } from './MessagePane'
import { NetworkModal } from './NetworkModal'
import { NewChatPrompt } from './NewChatPrompt'
import { TailPanels } from './TailPanels'
import { findExistingOneOnOne } from './derive'
import { useClampMessageCursor } from './hooks/useClampMessageCursor'
import { useHydrateMembers } from './hooks/useHydrateMembers'
import { useTerminalRows } from './hooks/useTerminalRows'
import { handleChatKeys } from './keybinds/chatKeys'
import { handleFilterKeys } from './keybinds/filterKeys'
import { handleListKeys } from './keybinds/listKeys'
import { handleMessageSearchKeys } from './keybinds/messageSearchKeys'
import { readMessagePageState, type LoadMoreState } from './messageRows'
import { messagesForTimelineNavigation } from './renderableMessage'
import { usePollerHandleRef } from './PollerContext'
import { StatusBar } from './StatusBar'
import { useAppState, useAppStore } from './StoreContext'
import type { Chat, DirectoryUser } from '../types'

const LIST_PANE_WIDTH = 30

function otherUserIdForFederatedResolution(
  chatId: string,
  chat: Chat | undefined,
  selfId: string,
): string | null {
  if (chat && chat.chatType !== 'oneOnOne') return null
  // Only look up federated equivalents for chats that look "detached"
  // (no message preview yet). Populated chats already point at the
  // canonical thread; running the resolver on every focused chat
  // generates 401 noise on in-tenant ids and burns Teams quota.
  if (chat && chat.lastMessagePreview) return null
  const member = chat?.members?.find((m) => m.userId && m.userId !== selfId)
  if (member?.userId) return member.userId
  const match = chatId.match(/^19:([^_@]+)_([^@]+)@unq\.gbl\.spaces$/)
  if (!match) return null
  const first = match[1]!
  const second = match[2]!
  if (first === selfId) return second
  if (second === selfId) return first
  return null
}

export function App() {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const store = useAppStore()
  const pollerRef = usePollerHandleRef()

  const terminalRows = useTerminalRows()

  const focus = useAppState((s) => s.focus)
  const cursor = useAppState((s) => s.cursor)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const me = useAppState((s) => s.me)
  const inputZone = useAppState((s) => s.inputZone)
  const filter = useAppState((s) => s.filter)
  const modal = useAppState((s) => s.modal)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const messageCacheByConvo = useAppState((s) => s.messageCacheByConvo)
  const messageCursorByConvo = useAppState((s) => s.messageCursorByConvo)

  const [newChatPrompt, setNewChatPrompt] = useState<string | null>(null)
  const federatedFocusCheckedRef = useRef<Set<string>>(new Set())

  // Side-effect hooks. These do not affect the render output directly;
  // they react to focus / message-list changes by updating the store.
  useHydrateMembers(focus, store)
  useClampMessageCursor(focus, messagesByConvo, store)
  useEffect(() => {
    if (focus.kind !== 'chat' || !me?.id) return
    if (federatedFocusCheckedRef.current.has(focus.chatId)) return
    const chat = chats.find((c) => c.id === focus.chatId)
    const otherUserId = otherUserIdForFederatedResolution(focus.chatId, chat, me.id)
    if (!otherUserId) return
    federatedFocusCheckedRef.current.add(focus.chatId)
    let cancelled = false
    void (async () => {
      const federatedChatId = await resolveFederatedChatId(me.id, otherUserId)
      if (!federatedChatId || federatedChatId === focus.chatId || cancelled) return
      const canonical = await materializeChat(federatedChatId)
      if (cancelled) return
      store.set((s) => ({
        chats: [canonical, ...s.chats.filter((c) => c.id !== canonical.id)],
        focus: { kind: 'chat', chatId: canonical.id },
        inputZone: 'list',
      }))
      pollerRef.current?.refresh()
    })()
    return () => {
      cancelled = true
    }
  }, [focus, me?.id, chats])

  const activeConv = focusKey(focus)
  const activeMessages = activeConv ? (messagesByConvo[activeConv] ?? []) : []
  const activeNavigationMessages = messagesForTimelineNavigation(activeMessages)
  const activeCache = activeConv ? messageCacheByConvo[activeConv] : undefined
  const activeMessageCursor =
    activeConv && activeNavigationMessages.length > 0
      ? clampCursor(
          messageCursorByConvo[activeConv] ?? activeNavigationMessages.length - 1,
          activeNavigationMessages.length,
        )
      : 0
  const focusedMessageId = activeNavigationMessages[activeMessageCursor]?.id
  const pageState = readMessagePageState(activeCache ?? activeMessages)
  const loadOlderState: LoadMoreState = pageState.loading
    ? 'loading'
    : pageState.error
      ? 'error'
      : pageState.hasOlder
        ? 'idle'
        : 'unavailable'

  function setMessageCursor(next: number): void {
    if (!activeConv || activeNavigationMessages.length === 0) return
    store.set((s) => ({
      messageCursorByConvo: setStoredMessageCursor(
        s.messageCursorByConvo,
        activeConv,
        next,
        activeNavigationMessages.length,
      ),
    }))
  }

  function moveMessageCursor(delta: number): void {
    if (!activeConv || activeNavigationMessages.length === 0) return
    store.set((s) => ({
      messageCursorByConvo: setStoredMessageCursor(
        s.messageCursorByConvo,
        activeConv,
        nextMessageCursor(activeMessageCursor, delta, activeNavigationMessages.length),
        activeNavigationMessages.length,
      ),
    }))
  }

  function jumpMessageBottom(): void {
    setMessageCursor(activeNavigationMessages.length - 1)
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
    const federatedChatId = await resolveFederatedChatId(selfId, user.id)
    if (federatedChatId) {
      const chat = await materializeChat(federatedChatId)
      setNewChatPrompt(null)
      store.set((s) => ({
        chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)],
        focus: { kind: 'chat', chatId: chat.id },
        inputZone: 'list',
        filter: '',
      }))
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

  async function resolveFederatedChatId(
    selfId: string,
    otherUserId: string,
  ): Promise<string | null> {
    try {
      return await resolveFederatedEquivalentConversationId(selfId, otherUserId)
    } catch (err) {
      recordEvent(
        'graph',
        'warn',
        `federated equivalent lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }

  async function materializeChat(chatId: string): Promise<Chat> {
    const local = store.get().chats.find((c) => c.id === chatId)
    if (local) return local
    return getChat(chatId, { members: true }).catch((err) => {
      recordEvent(
        'graph',
        'warn',
        `federated canonical chat hydrate failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return {
        id: chatId,
        chatType: 'oneOnOne' as const,
        createdDateTime: new Date().toISOString(),
      }
    })
  }

  const refresh = (): void => {
    pollerRef.current?.refresh()
  }

  const hardRefresh = (): void => {
    pollerRef.current?.hardRefresh?.()
  }

  // List / chat dispatcher. Tab is shared across both zones (move to
  // composer) so it lives here rather than being duplicated. The
  // per-zone handlers cover the rest.
  useInput(
    (input, key) => {
      if (input === 'R') {
        hardRefresh()
        return
      }
      if (key.tab && focus.kind !== 'list') {
        store.set({ inputZone: 'composer' })
        return
      }
      const raw = { input, key }
      // Chat / channel zone first when we're focused on a conversation —
      // most chat-zone keys (j/k/l/u/d) overlap with list-zone single
      // letters and we want the chat-side meaning when a chat is open.
      if (focus.kind !== 'list') {
        const result = handleChatKeys(raw, {
          store,
          focus,
          activeMessageCursor,
          focusedMessageId,
          moveMessageCursor,
          jumpMessageBottom,
          tryLoadOlder,
        })
        if (result === 'handled') return
      }
      handleListKeys(raw, {
        store,
        me,
        chats,
        teams,
        channelsByTeam,
        filter,
        cursor,
        focus,
        exit,
        refresh,
        hardRefresh,
        openNewChatPrompt,
      })
    },
    { isActive: isRawModeSupported && inputZone === 'list' },
  )

  // Filter-zone dispatcher.
  useInput(
    (input, key) => {
      handleFilterKeys(
        { input, key },
        {
          store,
          filter,
          me,
          chats,
          teams,
          channelsByTeam,
          openNewChatPrompt,
        },
      )
    },
    { isActive: isRawModeSupported && inputZone === 'filter' },
  )

  // In-conversation message search.
  const messageSearchQuery = useAppState((s) => s.messageSearchQuery)
  const messageSearchFocusedId = useAppState((s) => s.messageSearchFocusedId)
  useInput(
    (input, key) => {
      handleMessageSearchKeys(
        { input, key },
        {
          store,
          focus,
          query: messageSearchQuery,
          focusedHitId: messageSearchFocusedId,
          messages: activeNavigationMessages,
        },
      )
    },
    { isActive: isRawModeSupported && inputZone === 'message-search' },
  )

  // Modal rendering: header / composer / status bar stay visible; the
  // central row (ChatList + MessagePane) is replaced by the modal box.
  // Ink has no z-index so this is the closest "overlay" we can do.
  //
  return (
    <Box flexDirection="column" height={terminalRows}>
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
            ) : modal.kind === 'events' ? (
              <EventsModal />
            ) : modal.kind === 'network' ? (
              <NetworkModal />
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
      <TailPanels />
      <Box borderStyle="round" borderColor="gray">
        <Composer />
      </Box>
      <StatusBar />
    </Box>
  )
}
