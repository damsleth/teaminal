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

import { Box, useApp, useStdin, useStdout, type DOMElement } from 'ink'
import { inkBorder } from './theme'
import { useInput } from './useInput'
import { useEffect, useRef, useState } from 'react'
import { accountStore } from '../state/accountStore'
import { createOneOnOneChat, materializeChat, resolveFederatedChatId } from '../state/chatActions'
import { indexNameFromDirectoryUser } from '../state/nameIndex'
import { clampCursor, favoritesFor, selectableKey, unifiedSidebar } from '../state/selectables'
import { followTabs, retargetChatTab, tabsOn } from '../state/tabs'
import {
  focusKey,
  moveMessageCursor as nextMessageCursor,
  setMessageCursor as setStoredMessageCursor,
  type Focus,
  type InputZone,
  type ModalState,
} from '../state/store'
import { AccountsModal } from './AccountsModal'
import { AuthExpiredModal } from './AuthExpiredModal'
import { ChatList } from './ChatList'
import { Composer, composerHeaderRows } from './Composer'
import { ActivityModal, openActivity } from './ActivityModal'
import { DiagnosticsModal } from './DiagnosticsModal'
import { EventsModal } from './EventsModal'
import { HeaderBar } from './HeaderBar'
import { KeybindsModal } from './KeybindsModal'
import { MenuModal } from './MenuModal'
import { MessagePane } from './MessagePane'
import { NetworkModal } from './NetworkModal'
import { NewChatPrompt } from './NewChatPrompt'
import { ThemeEditorModal } from './ThemeEditorModal'
import { ThemePresetsModal } from './ThemePresetsModal'
import { ReactionPickerModal } from './ReactionPickerModal'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'
import { StatusNoteModal } from './StatusNoteModal'
import { EditReactionsModal } from './EditReactionsModal'
import { ImageModal } from './ImageModal'
import { MessageSearchModal, openMessageSearch } from './MessageSearchModal'
import { CommandPalette, openCommandPalette } from './CommandPalette'
import { ContextMenu } from './ContextMenu'
import { TailPanels } from './TailPanels'
import { findExistingOneOnOne } from './derive'
import { useClampMessageCursor } from './hooks/useClampMessageCursor'
import { useHydrateMembers } from './hooks/useHydrateMembers'
import { useTerminalRows } from './hooks/useTerminalRows'
import { handleChatKeys } from './keybinds/chatKeys'
import { handleFilterKeys } from './keybinds/filterKeys'
import {
  favoriteTarget,
  isFavorite,
  toggleFavorite,
  type FavoriteList,
  type FavoriteTarget,
  type ToForeground,
} from './keybinds/itemActions'
import {
  activateListRow,
  handleListKeys,
  listCtxNow,
  listCursorRow,
  stepListCursor,
  toggleListHeader,
  type ListKeysCtx,
} from './keybinds/listKeys'
import { handleMessageSearchKeys } from './keybinds/messageSearchKeys'
import { handleResizeKeys } from './keybinds/resizeKeys'
import {
  closeActiveTab,
  handleTabKeys,
  stepToTab,
  switchToTab,
  toggleConversationMode,
} from './keybinds/tabKeys'
import { computeLayout } from './layout'
import { hitsElement, listRowKeyAt, tabIndexAt } from './listHits'
import { readMessagePageState, type LoadMoreState } from './messageRows'
import { messagesForTimelineNavigation } from './renderableMessage'
import { channelReplyCount, messageFocusables } from './messageFocusables'
import { openExternal } from './openExternal'
import { usePollerHandleRef } from './PollerContext'
import { StatusBar } from './StatusBar'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { useSessionApi } from './SessionContext'
import { useMouse } from './useMouse'
import type { Chat, DirectoryUser } from '../types'

export function shouldShowTailPanels(modal: ModalState | null): boolean {
  return modal === null
}

export type ActivePane = 'list' | 'conversation' | 'composer' | null

// The pane that currently takes input, for the active border. Modals draw
// their own active border, so no pane is active behind one — including
// modals (e.g. confirm-delete-chat) that open without leaving the list zone.
export function activePane(zone: InputZone, focus: Focus, modalOpen = false): ActivePane {
  if (modalOpen) return null
  switch (zone) {
    case 'composer':
      return 'composer'
    case 'filter':
      return 'list'
    case 'message-search':
      return 'conversation'
    case 'list':
      return focus.kind === 'list' ? 'list' : 'conversation'
    default:
      return null
  }
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
  const session = useSessionApi()
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
  // The foreground account. Conversation-keyed state below is keyed by it
  // too: after a concurrent-mode swap the restored focus can be deep-equal
  // to the previous account's (colliding ids).
  const accountId = useAppState((s) => s.account?.id)
  // Unified sidebar: one list for every open account, so it is not remounted
  // on a foreground swap (the cursor stays on its row).
  const unified = useAppState(unifiedSidebar)
  const cursor = useAppState((s) => s.cursor)
  const cursorKey = useAppState((s) => s.cursorKey)
  const chats = useAppState((s) => s.chats)
  const teams = useAppState((s) => s.teams)
  const channelsByTeam = useAppState((s) => s.channelsByTeam)
  const me = useAppState((s) => s.me)
  const inputZone = useAppState((s) => s.inputZone)
  const chatListCollapsed = useAppState((s) => s.chatListCollapsed)
  const filter = useAppState((s) => s.filter)
  const modal = useAppState((s) => s.modal)
  const messagesByConvo = useAppState((s) => s.messagesByConvo)
  const messageCacheByConvo = useAppState((s) => s.messageCacheByConvo)
  const messageCursorByConvo = useAppState((s) => s.messageCursorByConvo)
  const focusedAttachmentIndex = useAppState((s) => s.focusedAttachmentIndex)
  const statusBarPosition = useAppState((s) => s.settings.statusBarPosition)
  const chatListWidthSetting = useAppState((s) => s.settings.chatListWidth)
  const composerHeightSetting = useAppState((s) => s.settings.composerHeight)
  const chatListSort = useAppState((s) => s.settings.chatListSort)
  const chatListGroupByType = useAppState((s) => s.settings.chatListGroupByType)
  const chatListSectionCap = useAppState((s) => s.settings.chatListSectionCap)
  const chatListCollapsedSections = useAppState((s) => s.settings.chatListCollapsedSections)
  const expandedChatSections = useAppState((s) => s.expandedChatSections)
  const nameByUserId = useAppState((s) => s.nameByUserId)
  const showFavorites = useAppState((s) => s.settings.showFavorites)
  const favoritesByAccount = useAppState((s) => s.settings.favoritesByAccount)
  const crossAccountFavorites = useAppState((s) => s.settings.crossAccountFavorites)
  const account = useAppState((s) => s.account)
  const conversationTabs = useAppState(tabsOn)

  const [newChatPrompt, setNewChatPrompt] = useState<string | null>(null)
  const federatedFocusCheckedRef = useRef<Set<string>>(new Set())

  // Side-effect hooks. These do not affect the render output directly;
  // they react to focus / message-list changes by updating the store.
  // Tabs mode: the open conversation always has its tab.
  useEffect(() => followTabs(store), [store])
  useHydrateMembers(focus, store)
  useClampMessageCursor(focus, messagesByConvo, store)
  // Reset attachment focus to the message body when the conversation changes.
  useEffect(() => {
    store.set({ focusedAttachmentIndex: 0 })
  }, [focus])
  useEffect(() => {
    if (focus.kind !== 'chat' || !me?.id) return
    const checkedKey = `${accountId ?? ''}\0${focus.chatId}`
    if (federatedFocusCheckedRef.current.has(checkedKey)) return
    const chat = chats.find((c) => c.id === focus.chatId)
    const otherUserId = otherUserIdForFederatedResolution(focus.chatId, chat, me.id)
    if (!otherUserId) return
    federatedFocusCheckedRef.current.add(checkedKey)
    let cancelled = false
    void (async () => {
      const federatedChatId = await resolveFederatedChatId(session.client(), me.id, otherUserId)
      if (!federatedChatId || federatedChatId === focus.chatId || cancelled) return
      const canonical = await materializeChat(
        session.client(),
        accountStore(store),
        federatedChatId,
      )
      if (cancelled) return
      store.set((s) => ({
        chats: [canonical, ...s.chats.filter((c) => c.id !== canonical.id)],
        focus: { kind: 'chat', chatId: canonical.id },
        inputZone: 'list',
        tabs: retargetChatTab(s.tabs, s.account?.id, focus.chatId, canonical.id),
      }))
      pollerRef.current?.refresh()
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, focus, me?.id, chats])

  // Compute dynamic layout dimensions from terminal size + settings.
  // The composer reports its wrapped line count (draft or edit text); App
  // re-renders only when it changes.
  const [draftLines, setDraftLines] = useState(1)
  const editingMessageId = useAppState((s) => s.editingMessageId)
  const layout = computeLayout({
    cols: terminalCols,
    rows: terminalRows,
    draftLines,
    quoteRows: composerHeaderRows(!!editingMessageId, focus, messagesByConvo),
    chatListWidth: chatListWidthSetting,
    composerHeight: composerHeightSetting,
  })
  const resolvedChatListWidth = layout.chatListWidth
  const resolvedComposerHeight = layout.composerHeight

  const activeConv = focusKey(focus)
  const activeMessages = activeConv ? (messagesByConvo[activeConv] ?? []) : []
  const activeNavigationMessages = messagesForTimelineNavigation(activeMessages, focus)
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
  // Focus ring for the focused message ([message, ...images, ...links, thread?]).
  // The stored index is clamped here so a message changing underneath the
  // cursor (new reaction, edit) can't leave focus pointing past the end.
  const focusables = messageFocusables(
    focusedMessage,
    channelReplyCount(focus, activeMessages, focusedMessageId),
  )
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

  function moveMessageCursor(delta: number, atEnd = false): void {
    if (!activeConv || activeNavigationMessages.length === 0) return
    const next = nextMessageCursor(activeMessageCursor, delta, activeNavigationMessages.length)
    store.set((s) => ({
      messageCursorByConvo: setStoredMessageCursor(
        s.messageCursorByConvo,
        activeConv,
        next,
        activeNavigationMessages.length,
      ),
      focusedAttachmentIndex: atEnd
        ? messageFocusables(
            activeNavigationMessages[next],
            channelReplyCount(focus, activeMessages, activeNavigationMessages[next]?.id),
          ).length - 1
        : 0,
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
    void pollerRef.current?.loadOlderMessages(focus)
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
      store.set((s) => ({
        nameByUserId: indexNameFromDirectoryUser(s.nameByUserId, user),
        focus: { kind: 'chat', chatId: existing.id },
        inputZone: 'list',
        filter: '',
      }))
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
    const federatedChatId = await resolveFederatedChatId(session.client(), selfId, user.id)
    if (federatedChatId) {
      const chat = await materializeChat(session.client(), accountStore(store), federatedChatId)
      setNewChatPrompt(null)
      store.set((s) => ({
        chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)],
        nameByUserId: indexNameFromDirectoryUser(s.nameByUserId, user),
        focus: { kind: 'chat', chatId: chat.id },
        inputZone: 'list',
        filter: '',
      }))
      pollerRef.current?.refresh()
      return
    }
    const chat = await createOneOnOneChat(session.client(), selfId, user.id)
    setNewChatPrompt(null)
    store.set((s) => ({
      chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)],
      nameByUserId: indexNameFromDirectoryUser(s.nameByUserId, user),
      focus: { kind: 'chat', chatId: chat.id },
      inputZone: 'list',
      filter: '',
    }))
    pollerRef.current?.refresh()
  }

  const refresh = (): void => {
    pollerRef.current?.refresh()
  }

  // Brings an open account to the foreground, keeping the list cursor and
  // filter: opening a row or a tab of another account.
  const toForeground: ToForeground = (alias) => session.setForeground(alias, { restoreUi: false })

  // Key actions the command palette offers besides menu items and chats.
  const paletteKeyActions: { id: string; title: string; keys: string; run: () => void }[] = [
    {
      id: 'new-chat',
      title: 'New chat / find a person',
      keys: 'p',
      run: () => openNewChatPrompt(''),
    },
    { id: 'search', title: 'Search all messages', keys: 's', run: () => openMessageSearch(store) },
    { id: 'refresh', title: 'Refresh', keys: 'r', run: () => refresh() },
    {
      id: 'hard-refresh',
      title: 'Hard refresh (refetch everything)',
      keys: 'R',
      run: () => hardRefresh(),
    },
    {
      id: 'activity',
      title: 'Activity / notifications',
      keys: 'Ctrl+A',
      run: () => openActivity(store),
    },
    {
      id: 'toggle-list',
      title: 'Show / hide the chat list',
      keys: 'Ctrl+B',
      run: () => store.set((s) => ({ chatListCollapsed: !s.chatListCollapsed })),
    },
    {
      id: 'resize',
      title: 'Resize panes',
      keys: 'Ctrl+X',
      run: () => store.set({ inputZone: 'resize' }),
    },
    {
      id: 'conversation-mode',
      title: conversationTabs ? 'Single conversation (no tabs)' : 'Conversation tabs',
      keys: 'Ctrl+T',
      run: () => toggleConversationMode(store),
    },
  ]
  // Tabs mode: the tab keys.
  if (conversationTabs) {
    paletteKeyActions.push(
      {
        id: 'next-tab',
        title: 'Next tab',
        keys: ']',
        run: () => stepToTab(store, 1, toForeground),
      },
      {
        id: 'previous-tab',
        title: 'Previous tab',
        keys: '[',
        run: () => stepToTab(store, -1, toForeground),
      },
      {
        id: 'close-tab',
        title: 'Close tab',
        keys: 'Ctrl+W',
        run: () => closeActiveTab(store, toForeground),
      },
    )
  }

  // The palette's favorite toggles for the row under the list cursor, built
  // only while the palette is open.
  function favoriteKeyActions(): typeof paletteKeyActions {
    // Reads listCtx: called below, once it is set.
    if (modal?.kind !== 'command-palette') return []
    const row = listCursorRow(listCtx)
    const t: FavoriteTarget | null = favoriteTarget(store, row)
    if (!row || !t) return []
    // Pin the row first, so the cursor goes with it when it moves.
    const toggle = (list: FavoriteList) => {
      store.set({ cursorKey: selectableKey(row) })
      toggleFavorite(store, list, t)
    }
    return [
      {
        id: 'favorite',
        title: isFavorite(store.get().settings, 'favoritesByAccount', t)
          ? 'Remove from favorites'
          : 'Add to favorites',
        keys: 'f',
        run: () => toggle('favoritesByAccount'),
      },
      {
        id: 'cross-favorite',
        title: isFavorite(store.get().settings, 'crossAccountFavorites', t)
          ? 'Remove from cross-account favorites'
          : 'Add to cross-account favorites',
        keys: 'Ctrl+F',
        run: () => toggle('crossAccountFavorites'),
      },
    ]
  }

  const hardRefresh = (): void => {
    pollerRef.current?.hardRefresh?.()
  }

  const listCtx: ListKeysCtx = {
    store,
    me,
    chats,
    teams,
    channelsByTeam,
    nameByUserId,
    settings: {
      chatListSort,
      chatListGroupByType,
      chatListSectionCap,
      chatListCollapsedSections,
    },
    filter,
    expandedChatSections,
    favorites: favoritesFor({ showFavorites, favoritesByAccount, crossAccountFavorites }, account),
    cursor,
    cursorKey,
    focus,
    exit,
    refresh,
    hardRefresh,
    openNewChatPrompt,
    toForeground,
  }
  paletteKeyActions.push(...favoriteKeyActions())

  // The wheel over the conversation: one message per report, onto the
  // message body (j / k also step through attachments). Read from the store,
  // so several reports in one chunk each count. At the top it loads older.
  function wheelMessages(dir: 1 | -1): void {
    const count = activeNavigationMessages.length
    if (!activeConv || count === 0) return
    const at = clampCursor(store.get().messageCursorByConvo[activeConv] ?? count - 1, count)
    if (dir < 0 && at === 0) tryLoadOlder()
    else setMessageCursor(at + dir)
  }

  // Mouse (settings.mouse): a left click on a sidebar row opens it, or
  // collapses / expands a header; the wheel moves the list cursor over the
  // sidebar and the message cursor over the conversation. Only over the
  // panes, never behind a modal or the new-chat prompt, and never with a
  // modifier held. A click from the composer or the filter, and the wheel
  // from the composer, move to the list zone (the draft and the filter
  // stay). Positions are those of the last painted frame.
  const listPaneRef = useRef<DOMElement>(null)
  const conversationRef = useRef<DOMElement>(null)
  useMouse((e) => {
    const { modal: openModal, inputZone: zone, focus: open } = store.get()
    if (openModal !== null || newChatPrompt !== null) return
    if (zone !== 'list' && zone !== 'composer' && zone !== 'filter') return
    if (e.shift || e.meta || e.ctrl) return
    const overList = hitsElement(listPaneRef.current, e.x, e.y)
    // A click on a conversation tab shows it.
    const tab = e.kind === 'down' && e.button === 'left' ? tabIndexAt(e.x, e.y) : null
    if (tab !== null && hitsElement(conversationRef.current, e.x, e.y)) {
      switchToTab(store, tab, toForeground)
      return
    }
    if (e.kind === 'down' && e.button === 'left' && overList) {
      const key = listRowKeyAt(e.x, e.y)
      if (!key) return
      store.set({ inputZone: 'list' })
      const ctx = listCtxNow(listCtx)
      if (!toggleListHeader(ctx, key)) activateListRow(ctx, key, { enter: true })
      return
    }
    if (e.kind !== 'wheel' || !e.wheel) return
    if (overList) {
      if (zone === 'composer') store.set({ inputZone: 'list' })
      stepListCursor(listCtxNow(listCtx), e.wheel)
    } else if (open.kind !== 'list' && hitsElement(conversationRef.current, e.x, e.y)) {
      // The pane follows the message cursor only in the list zone.
      if (zone === 'composer') store.set({ inputZone: 'list' })
      wheelMessages(e.wheel)
    }
  })

  // List / chat dispatcher. Tab is shared across both zones (move to
  // composer) so it lives here rather than being duplicated. The
  // per-zone handlers cover the rest.
  useInput(
    (input, key) => {
      if (input === 'R') {
        hardRefresh()
        return
      }
      if (key.ctrl && input === 'p') {
        openCommandPalette(store)
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
      if (key.ctrl && input === 'b') {
        store.set((s) => ({ chatListCollapsed: !s.chatListCollapsed }))
        return
      }
      if (key.tab && focus.kind !== 'list') {
        store.set({ inputZone: 'composer' })
        return
      }
      const raw = { input, key }
      // Tab keys ([ ] 1-9 Ctrl+W Ctrl+T) before the chat and list keys,
      // which read letters without their Ctrl.
      if (handleTabKeys(raw, { store, toForeground }) === 'handled') return
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
      handleListKeys(raw, listCtx)
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
    | 'theme-editor'
    | 'theme-presets'
    | 'accounts'
    | 'keybinds'
    | 'diagnostics'
    | 'events'
    | 'network'
    | 'activity'
    | 'status-note'
    | 'reaction-picker'
    | 'confirm-delete'
    | 'confirm-delete-chat'
    | 'message-search-global'
    | 'command-palette'
    | 'context-menu'
    | 'image'
    | 'edit-reactions'
    | null = modal && modal.kind !== 'auth-expired' ? modal.kind : null
  const replaceModal = modal?.kind === 'auth-expired' ? modal : null
  const showTailPanels = shouldShowTailPanels(modal)
  const theme = useTheme()
  const active = activePane(inputZone, focus, modal !== null)
  const paneBorder = (pane: ActivePane) =>
    pane === active
      ? { borderStyle: inkBorder(theme.borders.active), borderColor: theme.borderActive }
      : { borderStyle: inkBorder(theme.borders.panel), borderColor: theme.border }
  // Collapsed: one pane, showing the list while it has focus, else the chat.
  const showList = !chatListCollapsed || active === 'list'
  const showConversation = !chatListCollapsed || !showList
  const listWidth = chatListCollapsed ? terminalCols : resolvedChatListWidth
  const conversationListWidth = chatListCollapsed ? 0 : resolvedChatListWidth
  return (
    <Box
      flexDirection="column"
      height={terminalRows}
      backgroundColor={theme.appBackground ?? undefined}
    >
      {statusBarPosition === 'top' && <StatusBar />}
      <Box borderStyle={inkBorder(theme.borders.panel)} borderColor={theme.border} paddingX={1}>
        <HeaderBar columns={terminalCols} />
      </Box>
      <Box flexDirection="row" flexGrow={1} position="relative">
        {showList && (
          <Box ref={listPaneRef} width={listWidth} flexShrink={0} {...paneBorder('list')}>
            <ChatList key={unified ? 'unified' : accountId} listPaneWidth={listWidth} />
          </Box>
        )}
        <Box
          ref={conversationRef}
          display={showConversation ? 'flex' : 'none'}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          {...paneBorder('conversation')}
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
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <MessagePane
                key={accountId}
                focusedMessageId={focusedMessageId}
                focusIndicatorActive={focus.kind !== 'list' && inputZone === 'list'}
                loadOlderState={loadOlderState}
                listPaneWidth={conversationListWidth}
                composerRows={resolvedComposerHeight}
              />
            </Box>
          )}
        </Box>
        {/* Modals overlay both panes (chat list + conversation), so they get
            the full app width and never need the sidebar hidden to fit. */}
        {overlayModalKind && !replaceModal && newChatPrompt === null && (
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
            ) : overlayModalKind === 'theme-presets' ? (
              <ThemePresetsModal />
            ) : overlayModalKind === 'theme-editor' ? (
              <ThemeEditorModal />
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
            ) : overlayModalKind === 'status-note' ? (
              <StatusNoteModal />
            ) : overlayModalKind === 'reaction-picker' ? (
              <ReactionPickerModal />
            ) : overlayModalKind === 'confirm-delete' ||
              overlayModalKind === 'confirm-delete-chat' ? (
              <ConfirmDeleteModal />
            ) : overlayModalKind === 'message-search-global' ? (
              <MessageSearchModal />
            ) : overlayModalKind === 'context-menu' ? (
              <ContextMenu />
            ) : overlayModalKind === 'command-palette' ? (
              <CommandPalette keyActions={paletteKeyActions} />
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
      {showTailPanels && <TailPanels />}
      <Box {...paneBorder('composer')} height={resolvedComposerHeight}>
        <Composer
          key={accountId}
          columns={terminalCols}
          rows={resolvedComposerHeight - 2}
          onLines={setDraftLines}
        />
      </Box>
      {statusBarPosition === 'bottom' && <StatusBar />}
    </Box>
  )
}
