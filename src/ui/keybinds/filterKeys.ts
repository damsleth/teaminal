// Filter-zone keybind handler.
//
// Active when AppState.inputZone === 'filter'. Owns: typing into the
// filter buffer, Backspace deletion, Enter to commit (and optionally
// open the new-chat prompt when the filter looks like a person name
// nobody in the chat list matches), Esc to clear and exit.

import { buildSelectableList, itemMatchesFilter } from '../../state/selectables'
import type { AppState, Store } from '../../state/store'
import type { Channel, Chat, Team } from '../../types'
import type { Me } from '../../graph/me'
import { isNewChatQueryCandidate } from '../ChatList'
import type { KeyResult, RawKey } from './types'

export type FilterKeysCtx = {
  store: Store<AppState>
  filter: string
  me?: Me
  chats: Chat[]
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
  openNewChatPrompt: (initialQuery: string) => void
}

export function handleFilterKeys({ input, key }: RawKey, ctx: FilterKeysCtx): KeyResult {
  const { store } = ctx
  if (key.escape) {
    store.set({ filter: '', inputZone: 'list', cursor: 0 })
    return 'handled'
  }
  if (key.return) {
    const trimmed = ctx.filter.trim()
    if (isNewChatQueryCandidate(trimmed)) {
      const items = buildSelectableList(ctx)
      const visible = items.filter((it) => itemMatchesFilter(it, trimmed))
      if (visible.length === 0) {
        ctx.openNewChatPrompt(trimmed)
        return 'handled'
      }
    }
    store.set({ inputZone: 'list', cursor: 0 })
    return 'handled'
  }
  if (key.backspace || key.delete) {
    store.set({ filter: ctx.filter.slice(0, -1) })
    return 'handled'
  }
  if (input && !key.ctrl && !key.meta) {
    store.set({ filter: ctx.filter + input })
    return 'handled'
  }
  return 'pass'
}
