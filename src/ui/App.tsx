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

import { Box, useApp, useInput, useStdin, useStdout } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { createOneOnOneChat, materializeChat, resolveFederatedChatId } from '../state/chatActions'
import { clampCursor } from '../state/selectables'
import {
  focusKey,
  moveMessageCursor as nextMessageCursor,
  setMessageCursor as setStoredMessageCursor,
  type Focus,
  type ModalState,
} from '../state/store'
import { AccountsModal } from './AccountsModal'
import { AuthExpiredModal } from './AuthExpiredModal'
import { ChatList } from './ChatList'
import { Composer } from './Composer'
import { ActivityModal, openActivity } from './ActivityModal'
import { DiagnosticsModal } from './DiagnosticsModal'
import { EventsModal } from './EventsModal'
import { HeaderBar } from './HeaderBar'
import { KeybindsModal } from './KeybindsModal'
import { MenuModal } from './MenuModal'
import { MessagePane } from './MessagePane'
import { NetworkModal } from './NetworkModal'
import { NewChatPrompt } from './NewChatPrompt'
import { ReactionPickerModal } from './ReactionPickerModal'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'
import { EditReactionsModal } from './EditReactionsModal'
import { ImageModal } from './ImageModal'
import { MessageSearchModal } from './MessageSearchModal'
import { TailPanels } from './TailPanels'
import { findExistingOneOnOne } from './derive'
import { useClampMessageCursor } from './hooks/useClampMessageCursor'
import { useHydrateMembers } from './hooks/useHydrateMembers'
import { useTerminalRows } from './hooks/useTerminalRows'
import { handleChatKeys } from './keybinds/chatKeys'
import { handleFilterKeys } from './keybinds/filterKeys'
import { handleListKeys } from './keybinds/listKeys'
import { handleMessageSearchKeys } from './keybinds/messageSearchKeys'
import { handleResizeKeys } from './keybinds/resizeKeys'
import { computeLayout } from './layout'
import { readMessagePageState, type LoadMoreState } from './messageRows'
import { messagesForTimelineNavigation } from './renderableMessage'
import { messageFocusables } from './messageFocusables'
import { openExternal } from './openExternal'
import { usePollerHandleRef } from './PollerContext'
import { StatusBar } from './StatusBar'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import type { Chat, DirectoryUser } from '../types'

export function shouldShowTailPanels(modal: ModalState | null): boolean {
  return modal === null
}

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
  const { stdout: stdoutForCols } = useStdout()
  const [terminalCols, setTerminalCols] = useState<number>(stdoutForCols?.columns ?? 80)
  useEffect(() => {
    if (!stdoutForCols) return
    const onResize = () => setTerminalCols(stdoutForCols.columns ?? 80)
    stdoutForCols.on('resize', onResize)
    return () => {
      stdoutForCols.off('resize', onResize)
    }
  }, [stdoutForCols])

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
  const focusedAttachmentIndex = useAppState((s) => s.focusedAttachmentIndex)
  const statusBarPosition = useAppState((s) => s.settings.statusBarPosition)
  const chatListWidthSetting = useAppState((s) => s.settings.chatListWidth)
  const composerHeightSetting = useAppState((s) => s.settings.composerHeight)
  const draftsByConvo = useAppState((s) => s.draftsByConvo)

  const [newChatPrompt, setNewChatPrompt] = useState<string | null>(null)
  const federatedFocusCheckedRef = useRef<Set<string>>(new Set())

  // Side-effect hooks. These do not affect the render output directly;
  // they react to focus / message-list changes by updating the store.
  useHydrateMembers(focus, store)
  useClampMessageCursor(focus, messagesByConvo, store)
  // Reset attachment focus to the message body when the conversation changes.
  useEffect(() => {
    store.set({ focusedAttachmentIndex: 0 })
  }, [focus])
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
      const canonical = await materializeChat(store, federatedChatId)
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

  // Compute dynamic layout dimensions from terminal size + settings.
  const activeConvForDraft = focusKey(focus)
  const activeDraft = activeConvForDraft ? (draftsByConvo[activeConvForDraft] ?? '') : ''
  const draftLines = activeDraft ? activeDraft.split('\n').length : 1
  const layout = computeLayout({
    cols: terminalCols,
    rows: terminalRows,
    draftLines,
    quoteRows: 0,
    chatListWidth: chatListWidthSetting,
    composerHeight: composerHeightSetting,
  })
  const resolvedChatListWidth = layout.chatListWidth
  const resolvedComposerHeight = layout.composerHeight

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
  const focusedMessage = activeNavigationMessages[activeMessageCursor]
  const focusedMessageId = focusedMessage?.id
  // Focus ring for the focused message ([message, ...images, ...links]).
  // The stored index is clamped here so a message changing underneath the
  // cursor (new reaction, edit) can't leave focus pointing past the end.
  const focusables = messageFocusables(focusedMessage)
  const attachmentIndex = clampCursor(focusedAttachmentIndex, focusables.length)
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
      // Landing on a different message resets focus to that message's body.
      focusedAttachmentIndex: 0,
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
      focusedAttachmentIndex: 0,
    }))
  }

  // Set the focus index within the focused message's focusables, clamped to
  // the available range.
  function setAttachmentIndex(index: number): void {
    const clamped = clampCursor(index, focusables.length)
    store.set({ focusedAttachmentIndex: clamped })
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
    // Picking your own directory entry (incl. a same-name guest identity that
    // resolves to you) maps to the Teams notes-to-self chat. If it isn't in
    // the local list yet there's nothing to open - federated resolution and
    // Graph chat-create both require a distinct peer - so surface a clear
    // message rather than a cryptic "requires exactly two user IDs" throw.
    if (user.id === selfId) {
      throw new Error('That is your own account; open your notes-to-self chat from the list')
    }
    const federatedChatId = await resolveFederatedChatId(selfId, user.id)
    if (federatedChatId) {
      const chat = await materializeChat(store, federatedChatId)
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
      if (key.ctrl && input === 'a') {
        openActivity(store)
        return
      }
      if (key.ctrl && input === 'x') {
        store.set({ inputZone: 'resize' })
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
          focusedMessage,
          myUserId: me?.id,
          focusables,
          focusedAttachmentIndex: attachmentIndex,
          moveMessageCursor,
          jumpMessageBottom,
          tryLoadOlder,
          setAttachmentIndex,
          openLink: (href) => {
            openExternal(href)
          },
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

  // Resize-mode dispatcher. Entered via Ctrl-X in list zone.
  useInput(
    (input, key) => {
      handleResizeKeys(
        { input, key },
        {
          store,
          currentChatListWidth: resolvedChatListWidth,
          currentComposerHeight: resolvedComposerHeight,
        },
      )
    },
    { isActive: isRawModeSupported && inputZone === 'resize' },
  )

  // Modal rendering: header / composer / status bar stay visible. The
  // menu / accounts / keybinds / diagnostics / events / network modals
  // render as absolute-positioned overlays on top of the message pane,
  // so the active chat stays visible behind them. Only the
  // auth-expired modal still replaces the pane (the chat isn't
  // actionable when auth is broken).
  //
  const overlayModalKind:
    | 'menu'
    | 'accounts'
    | 'keybinds'
    | 'diagnostics'
    | 'events'
    | 'network'
    | 'activity'
    | 'reaction-picker'
    | 'confirm-delete'
    | 'message-search-global'
    | 'image'
    | 'edit-reactions'
    | null = modal && modal.kind !== 'auth-expired' ? modal.kind : null
  const replaceModal = modal?.kind === 'auth-expired' ? modal : null
  const showTailPanels = shouldShowTailPanels(modal)
  const theme = useTheme()
  return (
    <Box flexDirection="column" height={terminalRows}>
      <Box
        borderStyle={theme.borders.panel}
        borderColor={theme.border}
        paddingX={theme.layout.panePaddingX}
      >
        <HeaderBar />
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box
          width={resolvedChatListWidth}
          flexShrink={0}
          borderStyle={theme.borders.panel}
          borderColor={theme.border}
        >
          <ChatList listPaneWidth={resolvedChatListWidth} />
        </Box>
        <Box
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          borderStyle={theme.borders.panel}
          borderColor={theme.border}
        >
          {newChatPrompt !== null ? (
            <NewChatPrompt
              initialQuery={newChatPrompt}
              selfId={me?.id}
              onClose={closeNewChatPrompt}
              onSelectUser={createOrFocusChat}
            />
          ) : replaceModal ? (
            <AuthExpiredModal />
          ) : (
            <Box
              flexDirection="column"
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              position="relative"
            >
              <MessagePane
                focusedMessageId={focusedMessageId}
                focusIndicatorActive={focus.kind !== 'list' && inputZone === 'list'}
                loadOlderState={loadOlderState}
                listPaneWidth={resolvedChatListWidth}
              />
              {overlayModalKind && (
                <Box
                  position="absolute"
                  top={0}
                  left={0}
                  right={0}
                  bottom={0}
                  flexDirection="column"
                  alignItems="center"
                  justifyContent="center"
                >
                  {overlayModalKind === 'menu' ? (
                    <MenuModal />
                  ) : overlayModalKind === 'accounts' ? (
                    <AccountsModal />
                  ) : overlayModalKind === 'keybinds' ? (
                    <KeybindsModal />
                  ) : overlayModalKind === 'diagnostics' ? (
                    <DiagnosticsModal />
                  ) : overlayModalKind === 'events' ? (
                    <EventsModal />
                  ) : overlayModalKind === 'activity' ? (
                    <ActivityModal />
                  ) : overlayModalKind === 'reaction-picker' ? (
                    <ReactionPickerModal />
                  ) : overlayModalKind === 'confirm-delete' ? (
                    <ConfirmDeleteModal />
                  ) : overlayModalKind === 'message-search-global' ? (
                    <MessageSearchModal />
                  ) : overlayModalKind === 'image' ? (
                    <ImageModal />
                  ) : overlayModalKind === 'edit-reactions' ? (
                    <EditReactionsModal />
                  ) : (
                    <NetworkModal />
                  )}
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>
      {showTailPanels && <TailPanels />}
      <Box
        borderStyle={theme.borders.panel}
        borderColor={theme.border}
        height={resolvedComposerHeight}
      >
        <Composer />
      </Box>
      {statusBarPosition !== 'hidden' && <StatusBar />}
    </Box>
  )
}
