// List-zone keybind handler.
//
// Active when AppState.inputZone === 'list' AND the user has not opened
// a modal. Owns: cursor up/down, Enter/h/l navigation, q to quit, /
// to enter filter mode, n for new-chat, ? for keybinds, r/R for refresh.

import type { Channel, Chat, Team } from '../../types'
import type { Me } from '../../graph/me'
import { accountRef } from '../../account'
import { accountStoreFor } from '../../state/accountStore'
import { focusKey, type AppState, type Focus, type Settings, type Store } from '../../state/store'
import {
  buildSelectableList,
  clampCursor,
  collapseKeyFor,
  cursorAt,
  firstSelectableIndex,
  headerIndexForKey,
  isSelectable,
  nextSelectableIndex,
  parentCollapseKey,
  resolveCursor,
  selectableKey,
  unifiedListInput,
  visibleList,
  type SelectableItem,
} from '../../state/selectables'
import { updateSettings } from '../../config/index'
import { warn } from '../../log'
import { isNewChatQueryCandidate } from '../ChatList'
import { openKeybinds } from '../KeybindsModal'
import { openMenu } from '../MenuModal'
import { openContextMenu } from '../ContextMenu'
import { openMessageSearch } from '../MessageSearchModal'
import {
  bringToFront,
  confirmDeleteChat,
  openFocus,
  toggleChatRead,
  type ToForeground,
} from './itemActions'
import type { KeyResult, RawKey } from './types'

const HALF_PAGE = 10

export type ListKeysCtx = {
  store: Store<AppState>
  me?: Me
  chats: Chat[]
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
  // Passed through to buildSelectableList so navigation order/labels match
  // exactly what ChatList renders (matters once chatListSort reorders rows).
  nameByUserId?: Record<string, string>
  settings: Pick<Settings, 'chatListSort' | 'chatListGroupByType'> & {
    chatListSectionCap?: boolean
    chatListCollapsedSections?: Record<string, boolean>
  }
  filter: string
  expandedChatSections: Record<string, boolean>
  cursor: number
  cursorKey?: string | null
  focus: Focus
  exit: () => void
  refresh: () => void
  hardRefresh: () => void
  openNewChatPrompt: (initialQuery?: string) => void
  // Unified sidebar: bring a row's account to the foreground before opening
  // it. Absent (single mode, tests) = rows are always the foreground's.
  toForeground?: ToForeground
}

// The navigable list. In the unified sidebar it comes from every open
// account in the store; otherwise from the foreground fields in ctx.
function listFor(ctx: ListKeysCtx): SelectableItem[] {
  const unified = unifiedListInput(ctx.store.get())
  return unified ? visibleList(unified) : visibleList(ctx)
}

// Collapsed sections are a persisted setting: patch the store for the current
// render and write through to config.json. Persistence is fire-and-forget —
// a failed write costs the user a collapsed section across restarts, nothing
// more, and must not break the keypress — but it is logged, because silence
// here is how an unwritable config dir went unnoticed.
// An account's own section and team keys (`explicit`) are reopened with an
// explicit false rather than deleted: an unprefixed legacy key for the same
// section would otherwise keep it collapsed.
function setSectionCollapsed(
  store: Store<AppState>,
  key: string,
  collapsed: boolean,
  explicit = false,
): void {
  let next: Record<string, boolean> = {}
  store.set((s) => {
    next = { ...s.settings.chatListCollapsedSections }
    if (collapsed) next[key] = true
    else if (explicit) next[key] = false
    else delete next[key]
    return { settings: { ...s.settings, chatListCollapsedSections: next } }
  })
  void updateSettings({ chatListCollapsedSections: next }).catch((err) => {
    warn(
      'config: failed to persist collapsed sections:',
      err instanceof Error ? err.message : String(err),
    )
  })
}

// The chat ctrl+d acts on. Channels have no delete, so a focused channel
// (or a cursor sitting on one) yields nothing.
// A list row's `alias` is its account in the unified sidebar; a focused chat
// is always the foreground's.
function deleteTarget(ctx: ListKeysCtx): { chat: Chat; label: string; alias?: string } | null {
  if (ctx.focus.kind === 'chat') {
    const chatId = ctx.focus.chatId
    const chat = ctx.chats.find((c) => c.id === chatId)
    return chat ? { chat, label: labelForChat(ctx, chat) } : null
  }
  if (ctx.focus.kind !== 'list') return null
  const visible = listFor(ctx)
  const it = visible[resolveCursor(visible, visible.length, ctx.cursorKey ?? null, ctx.cursor)]
  return it && it.kind === 'chat'
    ? { chat: it.chat, label: it.label, ...(it.alias === undefined ? {} : { alias: it.alias }) }
    : null
}

// The account of the row under the list cursor (unified sidebar), or
// undefined for the foreground.
function cursorAlias(ctx: ListKeysCtx): string | undefined {
  if (ctx.focus.kind !== 'list') return undefined
  const visible = listFor(ctx)
  return visible[resolveCursor(visible, visible.length, ctx.cursorKey ?? null, ctx.cursor)]?.alias
}

// The focused chat is always the foreground's, so its label comes from the
// foreground fields in ctx.
function labelForChat(ctx: ListKeysCtx, chat: Chat): string {
  const item = buildSelectableList(ctx).find(
    (it): it is Extract<typeof it, { kind: 'chat' }> =>
      it.kind === 'chat' && it.chat.id === chat.id,
  )
  return item?.label ?? chat.topic ?? chat.id
}

export function handleListKeys({ input, key }: RawKey, ctx: ListKeysCtx): KeyResult {
  const { store, exit, refresh, hardRefresh, openNewChatPrompt } = ctx
  const ch = input.toLowerCase()

  if (key.ctrl && ch === 'c') {
    exit()
    return 'handled'
  }

  // '.' (Ctrl+. where the terminal reports it) opens the context menu for
  // the chat row under the cursor.
  if (input === '.' && ctx.focus.kind === 'list') {
    const target = deleteTarget(ctx)
    if (target)
      openContextMenu(store, {
        kind: 'chat',
        chatId: target.chat.id,
        label: target.label,
        ...(target.alias === undefined ? {} : { alias: target.alias }),
      })
    return 'handled'
  }

  // ctrl+d deletes a chat: the open one when a chat is focused, otherwise
  // the row under the list cursor. Confirmation lives in the modal.
  if (key.ctrl && ch === 'd') {
    const target = deleteTarget(ctx)
    if (target) {
      confirmDeleteChat(store, target.chat.id, target.label, target.alias)
    }
    return 'handled'
  }

  // R clears visible slices first, then forces an immediate refresh.
  if (input === 'R') {
    hardRefresh()
    return 'handled'
  }

  // r forces an immediate refresh of the active conv + chat list.
  if (ch === 'r') {
    refresh()
    return 'handled'
  }

  // / enters filter mode when in list focus.
  if (ctx.focus.kind === 'list' && input === '/') {
    store.set({ inputZone: 'filter' })
    return 'handled'
  }

  // ? opens the keybindings reference.
  if (input === '?') {
    openKeybinds(store)
    return 'handled'
  }

  // s opens tenant-wide server-side message search (distinct from the
  // in-conversation `/` search bar).
  if (ch === 's') {
    openMessageSearch(store)
    return 'handled'
  }

  // p opens the people directory search (find a person, start a 1:1).
  // Directory search never spans tenants: the prompt searches the account
  // whose section the cursor is in, so that account comes to the front.
  if (ch === 'p') {
    if (bringToFront(store, cursorAlias(ctx), ctx.toForeground)) openNewChatPrompt('')
    return 'handled'
  }

  // List-focus navigation (cursor + open).
  if (ctx.focus.kind === 'list') {
    if (ch === 'q') {
      exit()
      return 'handled'
    }
    const visible = listFor(ctx)
    const syntheticNewChatQuery =
      ctx.filter && visible.length === 0 && isNewChatQueryCandidate(ctx.filter)
        ? ctx.filter.trim()
        : null
    const selectableCount = visible.length + (syntheticNewChatQuery ? 1 : 0)
    if (ch === 'n') {
      if (bringToFront(store, cursorAlias(ctx), ctx.toForeground)) openNewChatPrompt(ctx.filter)
      return 'handled'
    }
    // m toggles unread/read on the focused chat row. Channels and
    // teams have no unread state to flip.
    if (ch === 'm') {
      const safe = resolveCursor(visible, selectableCount, ctx.cursorKey ?? null, ctx.cursor)
      const it = visible[safe]
      if (it && it.kind === 'chat') toggleChatRead(store, it.chat, it.alias)
      return 'handled'
    }
    if (selectableCount === 0) {
      // Esc still has meaning even when the list is empty.
      if (key.escape) {
        openMenu(store)
        return 'handled'
      }
      return 'pass'
    }
    // Teams render as non-selectable headers; cursor must skip them.
    // If the stored cursor happens to land on a team (e.g. just after a
    // filter change reordered the list), advance forward to the next
    // selectable item first.
    let safe = resolveCursor(visible, selectableCount, ctx.cursorKey ?? null, ctx.cursor)
    if (safe < visible.length && !isSelectable(visible[safe]!)) {
      safe = nextSelectableIndex(visible, safe, +1)
      if (safe < visible.length && !isSelectable(visible[safe]!)) {
        safe = firstSelectableIndex(visible)
      }
    }
    if (ch === 'j' || key.downArrow) {
      const next = nextSelectableIndex(visible, safe, +1)
      const max = selectableCount - 1
      store.set(cursorAt(visible, clampCursor(Math.min(next, max), selectableCount)))
      return 'handled'
    }
    if (ch === 'k' || key.upArrow) {
      const next = nextSelectableIndex(visible, safe, -1)
      store.set(cursorAt(visible, clampCursor(next, selectableCount)))
      return 'handled'
    }
    if (ch === 'u' || (key as typeof key & { pageUp?: boolean }).pageUp) {
      let target = clampCursor(safe - HALF_PAGE, selectableCount)
      if (target < visible.length && !isSelectable(visible[target]!)) {
        target = nextSelectableIndex(visible, target, -1)
        const at = visible[target]
        if (at && !isSelectable(at)) target = firstSelectableIndex(visible)
      }
      store.set(cursorAt(visible, clampCursor(target, selectableCount)))
      return 'handled'
    }
    if (ch === 'd' || (key as typeof key & { pageDown?: boolean }).pageDown) {
      let target = clampCursor(safe + HALF_PAGE, selectableCount)
      if (target < visible.length && !isSelectable(visible[target]!)) {
        target = nextSelectableIndex(visible, target, +1)
        if (target < visible.length && !isSelectable(visible[target]!)) {
          // No non-team rows after the original target — fall back to last
          // selectable.
          target = nextSelectableIndex(visible, target, -1)
        }
      }
      store.set(cursorAt(visible, clampCursor(target, selectableCount)))
      return 'handled'
    }
    if (ch === 'h' || key.leftArrow) {
      // Collapse the section the focused row belongs to (its chat type, or its
      // team for a channel) and put the cursor on that header — collapsed
      // headers are selectable, so the section can be reopened with l/Enter.
      // A focused header, or a row with no section (ungrouped chat), stays
      // put: the list is the leftmost pane, so h must not fall through to the
      // filter buffer.
      // An account header collapses itself (it has no parent).
      const focused = visible[safe]
      const collapseKey = !focused
        ? null
        : focused.kind === 'account'
          ? collapseKeyFor(focused)
          : parentCollapseKey(focused, ctx.settings.chatListGroupByType)
      if (collapseKey) {
        setSectionCollapsed(store, collapseKey, true)
        // The header may be filtered out of the current view; then there is
        // nothing to move the cursor onto.
        const header = headerIndexForKey(visible, collapseKey)
        if (header !== null) store.set(cursorAt(visible, header))
      }
      return 'handled'
    }
    if (key.return || ch === 'l' || key.rightArrow) {
      if (syntheticNewChatQuery && safe === visible.length) {
        openNewChatPrompt(syntheticNewChatQuery)
        return 'handled'
      }
      const it = visible[safe]
      if (!it) return 'handled'
      if (it.kind === 'account') {
        // Enter on a failed account opens the Accounts modal on its row,
        // where it can be retried.
        if (key.return && (it.conn === 'authError' || it.conn === 'offline')) {
          const row = store.get().settings.accounts.indexOf(it.alias)
          store.set({
            modal: { kind: 'accounts', mode: 'list', cursor: Math.max(0, row), accounts: [] },
            inputZone: 'menu',
          })
          return 'handled'
        }
        // Expand (when collapsed), then move to the account's first row; an
        // empty account keeps the cursor on its header.
        if (it.collapsed) setSectionCollapsed(store, collapseKeyFor(it)!, false)
        const now = listFor(ctx)
        const at = now.findIndex((row) => selectableKey(row) === selectableKey(it))
        const next = at < 0 ? at : nextSelectableIndex(now, at, +1)
        store.set(cursorAt(now, next > at && now[next]?.alias === it.alias ? next : at))
        return 'handled'
      }
      const headerKey = collapseKeyFor(it)
      if (headerKey && it.alias !== undefined) {
        setSectionCollapsed(store, headerKey, false, true)
        const expanded = listFor(ctx)
        store.set(cursorAt(expanded, nextSelectableIndex(expanded, safe, +1)))
        return 'handled'
      }
      if (headerKey) {
        // Only collapsed headers are focusable, so this always expands. The
        // cursor lands on the first selectable child — for Teams that skips
        // the (expanded, unselectable) first team header to its channel.
        setSectionCollapsed(store, headerKey, false)
        const expanded = buildSelectableList({
          ...ctx,
          settings: {
            ...ctx.settings,
            chatListCollapsedSections: store.get().settings.chatListCollapsedSections,
          },
        })
        store.set(cursorAt(expanded, nextSelectableIndex(expanded, safe, +1)))
        return 'handled'
      }
      if (it.kind === 'more' && it.alias !== undefined) {
        // The row's own account expands its section.
        const section = it.section
        accountStoreFor(store, accountRef(it.alias)).set((s) => ({
          expandedChatSections: { ...s.expandedChatSections, [section]: true },
        }))
        store.set(cursorAt(listFor(ctx), safe))
        return 'handled'
      }
      if (it.kind === 'more') {
        // Expanding replaces the `… N more` row with the first hidden chat,
        // so the cursor stays where it is and lands on real content.
        const section = it.section
        const expandedChatSections = { ...store.get().expandedChatSections, [section]: true }
        store.set({
          expandedChatSections,
          ...cursorAt(buildSelectableList({ ...ctx, expandedChatSections }), safe),
        })
        return 'handled'
      }
      if (it.kind === 'chat' && it.alias !== undefined) {
        openFocus(store, { kind: 'chat', chatId: it.chat.id }, it.alias, ctx.toForeground)
      } else if (it.kind === 'channel' && it.alias !== undefined) {
        openFocus(
          store,
          { kind: 'channel', teamId: it.team.id, channelId: it.channel.id },
          it.alias,
          ctx.toForeground,
        )
      } else if (it.kind === 'chat') {
        store.set({ focus: { kind: 'chat', chatId: it.chat.id } })
      } else if (it.kind === 'channel') {
        store.set({
          focus: { kind: 'channel', teamId: it.team.id, channelId: it.channel.id },
        })
      }
      // team selection is a no-op in v1 (no team-detail view yet)
      return 'handled'
    }
    if (key.escape) {
      openMenu(store)
      return 'handled'
    }
  }

  return 'pass'
}

// Re-export so consumers can derive focusKey without re-importing the store.
export { focusKey }
