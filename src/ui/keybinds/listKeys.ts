// List-zone keybind handler.
//
// Active when AppState.inputZone === 'list' AND the user has not opened
// a modal. Owns: cursor up/down, Enter/h/l navigation, q to quit, /
// to enter filter mode, n for new-chat, ? for keybinds, r/R for refresh.

import type { Channel, Chat, Team } from '../../types'
import type { Me } from '../../graph/me'
import {
  focusKey,
  toggleChatUnread,
  type AppState,
  type Focus,
  type Settings,
  type Store,
} from '../../state/store'
import {
  buildSelectableList,
  clampCursor,
  collapseKeyFor,
  firstSelectableIndex,
  headerIndexForKey,
  isSelectable,
  itemMatchesFilter,
  nextSelectableIndex,
  parentCollapseKey,
} from '../../state/selectables'
import { updateSettings } from '../../config/index'
import { isNewChatQueryCandidate } from '../ChatList'
import { openKeybinds } from '../KeybindsModal'
import { openMenu } from '../MenuModal'
import { openMessageSearch } from '../MessageSearchModal'
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
    chatListCollapsedSections?: Record<string, boolean>
  }
  filter: string
  expandedChatSections: Record<string, boolean>
  cursor: number
  focus: Focus
  exit: () => void
  refresh: () => void
  hardRefresh: () => void
  openNewChatPrompt: (initialQuery?: string) => void
}

// Collapsed sections are a persisted setting: patch the store for the current
// render and write through to config.json. Persistence is fire-and-forget —
// a failed write costs the user a collapsed section across restarts, nothing
// more, and must not break the keypress.
function setSectionCollapsed(store: Store<AppState>, key: string, collapsed: boolean): void {
  let next: Record<string, boolean> = {}
  store.set((s) => {
    next = { ...s.settings.chatListCollapsedSections }
    if (collapsed) next[key] = true
    else delete next[key]
    return { settings: { ...s.settings, chatListCollapsedSections: next } }
  })
  void updateSettings({ chatListCollapsedSections: next }).catch(() => undefined)
}

// The chat ctrl+d acts on. Channels have no delete, so a focused channel
// (or a cursor sitting on one) yields nothing.
function deleteTarget(ctx: ListKeysCtx): { chat: Chat; label: string } | null {
  if (ctx.focus.kind === 'chat') {
    const chatId = ctx.focus.chatId
    const chat = ctx.chats.find((c) => c.id === chatId)
    return chat ? { chat, label: labelForChat(ctx, chat) } : null
  }
  if (ctx.focus.kind !== 'list') return null
  const items = buildSelectableList(ctx)
  const visible = ctx.filter ? items.filter((it) => itemMatchesFilter(it, ctx.filter)) : items
  const it = visible[clampCursor(ctx.cursor, visible.length)]
  return it && it.kind === 'chat' ? { chat: it.chat, label: it.label } : null
}

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

  // ctrl+d deletes a chat: the open one when a chat is focused, otherwise
  // the row under the list cursor. Confirmation lives in the modal.
  if (key.ctrl && ch === 'd') {
    const target = deleteTarget(ctx)
    if (target) {
      store.set({
        modal: { kind: 'confirm-delete-chat', chatId: target.chat.id, label: target.label },
        inputZone: 'list',
      })
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
  if (ch === 'p') {
    openNewChatPrompt('')
    return 'handled'
  }

  // List-focus navigation (cursor + open).
  if (ctx.focus.kind === 'list') {
    if (ch === 'q') {
      exit()
      return 'handled'
    }
    const items = buildSelectableList(ctx)
    const visible = ctx.filter ? items.filter((it) => itemMatchesFilter(it, ctx.filter)) : items
    const syntheticNewChatQuery =
      ctx.filter && visible.length === 0 && isNewChatQueryCandidate(ctx.filter)
        ? ctx.filter.trim()
        : null
    const selectableCount = visible.length + (syntheticNewChatQuery ? 1 : 0)
    if (ch === 'n') {
      openNewChatPrompt(ctx.filter)
      return 'handled'
    }
    // m toggles unread/read on the focused chat row. Channels and
    // teams have no unread state to flip.
    if (ch === 'm') {
      const items = buildSelectableList(ctx)
      const visible = ctx.filter ? items.filter((it) => itemMatchesFilter(it, ctx.filter)) : items
      const safe = clampCursor(ctx.cursor, visible.length + (syntheticNewChatQuery ? 1 : 0))
      const it = visible[safe]
      if (it && it.kind === 'chat') {
        const chat = it.chat
        store.set((s) => ({
          unreadByChatId: toggleChatUnread(s.unreadByChatId, chat),
        }))
      }
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
    let safe = clampCursor(ctx.cursor, selectableCount)
    if (safe < visible.length && !isSelectable(visible[safe]!)) {
      safe = nextSelectableIndex(visible, safe, +1)
      if (safe < visible.length && !isSelectable(visible[safe]!)) {
        safe = firstSelectableIndex(visible)
      }
    }
    if (ch === 'j' || key.downArrow) {
      const next = nextSelectableIndex(visible, safe, +1)
      const max = selectableCount - 1
      store.set({ cursor: clampCursor(Math.min(next, max), selectableCount) })
      return 'handled'
    }
    if (ch === 'k' || key.upArrow) {
      const next = nextSelectableIndex(visible, safe, -1)
      store.set({ cursor: clampCursor(next, selectableCount) })
      return 'handled'
    }
    if (ch === 'u' || (key as typeof key & { pageUp?: boolean }).pageUp) {
      let target = clampCursor(safe - HALF_PAGE, selectableCount)
      if (target < visible.length && !isSelectable(visible[target]!)) {
        target = nextSelectableIndex(visible, target, -1)
        const at = visible[target]
        if (at && !isSelectable(at)) target = firstSelectableIndex(visible)
      }
      store.set({ cursor: clampCursor(target, selectableCount) })
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
      store.set({ cursor: clampCursor(target, selectableCount) })
      return 'handled'
    }
    if (ch === 'h' || key.leftArrow) {
      // Collapse the section the focused row belongs to (its chat type, or its
      // team for a channel) and put the cursor on that header — collapsed
      // headers are selectable, so the section can be reopened with l/Enter.
      // A focused header, or a row with no section (ungrouped chat), stays
      // put: the list is the leftmost pane, so h must not fall through to the
      // filter buffer.
      const focused = visible[safe]
      const collapseKey = focused
        ? parentCollapseKey(focused, ctx.settings.chatListGroupByType)
        : null
      if (collapseKey) {
        setSectionCollapsed(store, collapseKey, true)
        // The header may be filtered out of the current view; then there is
        // nothing to move the cursor onto.
        const header = headerIndexForKey(visible, collapseKey)
        if (header !== null) store.set({ cursor: header })
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
      const headerKey = collapseKeyFor(it)
      if (headerKey) {
        // Only collapsed headers are focusable, so this always expands. The
        // first child lands right after the header the cursor is on.
        setSectionCollapsed(store, headerKey, false)
        store.set({ cursor: safe + 1 })
        return 'handled'
      }
      if (it.kind === 'more') {
        // Expanding replaces the `… N more` row with the first hidden chat,
        // so the cursor stays where it is and lands on real content.
        const section = it.section
        store.set((s) => ({
          expandedChatSections: { ...s.expandedChatSections, [section]: true },
        }))
        return 'handled'
      }
      if (it.kind === 'chat') {
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
