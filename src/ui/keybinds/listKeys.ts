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
  type Store,
} from '../../state/store'
import { buildSelectableList, clampCursor, itemMatchesFilter } from '../../state/selectables'
import { isNewChatQueryCandidate } from '../ChatList'
import { openKeybinds } from '../KeybindsModal'
import { openMenu } from '../MenuModal'
import type { KeyResult, RawKey } from './types'

const HALF_PAGE = 10

export type ListKeysCtx = {
  store: Store<AppState>
  me?: Me
  chats: Chat[]
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
  filter: string
  cursor: number
  focus: Focus
  exit: () => void
  refresh: () => void
  hardRefresh: () => void
  openNewChatPrompt: (initialQuery?: string) => void
}

export function handleListKeys({ input, key }: RawKey, ctx: ListKeysCtx): KeyResult {
  const { store, exit, refresh, hardRefresh, openNewChatPrompt } = ctx
  const ch = input.toLowerCase()

  if (key.ctrl && ch === 'c') {
    exit()
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
    const safe = clampCursor(ctx.cursor, selectableCount)
    if (ch === 'j' || key.downArrow) {
      store.set({ cursor: clampCursor(safe + 1, selectableCount) })
      return 'handled'
    }
    if (ch === 'k' || key.upArrow) {
      store.set({ cursor: clampCursor(safe - 1, selectableCount) })
      return 'handled'
    }
    if (ch === 'u' || (key as typeof key & { pageUp?: boolean }).pageUp) {
      store.set({ cursor: clampCursor(safe - HALF_PAGE, selectableCount) })
      return 'handled'
    }
    if (ch === 'd' || (key as typeof key & { pageDown?: boolean }).pageDown) {
      store.set({ cursor: clampCursor(safe + HALF_PAGE, selectableCount) })
      return 'handled'
    }
    if (ch === 'h' || key.leftArrow) {
      // List is already the leftmost pane; no-op so we don't fall
      // through into the filter buffer.
      return 'handled'
    }
    if (key.return || ch === 'l' || key.rightArrow) {
      if (syntheticNewChatQuery && safe === visible.length) {
        openNewChatPrompt(syntheticNewChatQuery)
        return 'handled'
      }
      const it = visible[safe]
      if (!it) return 'handled'
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

/**
 * For convenience, expose a "selectable count" calculator the App can
 * use when it needs to short-circuit before invoking the dispatcher.
 * Pure, no side effects.
 */
export function listSelectableCount(
  ctx: Omit<ListKeysCtx, 'exit' | 'refresh' | 'hardRefresh' | 'openNewChatPrompt'>,
): {
  visible: ReturnType<typeof buildSelectableList>
  selectableCount: number
  syntheticNewChatQuery: string | null
} {
  const items = buildSelectableList(ctx)
  const visible = ctx.filter ? items.filter((it) => itemMatchesFilter(it, ctx.filter)) : items
  const syntheticNewChatQuery =
    ctx.filter && visible.length === 0 && isNewChatQueryCandidate(ctx.filter)
      ? ctx.filter.trim()
      : null
  const selectableCount = visible.length + (syntheticNewChatQuery ? 1 : 0)
  return { visible, selectableCount, syntheticNewChatQuery }
}

// Re-export so consumers can derive focusKey without re-importing the store.
export { focusKey }
