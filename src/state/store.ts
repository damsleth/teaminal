// Tiny pub/sub store. No external dependency.
//
// Patch-style updates: `store.set({ chats: nextChats })` shallow-merges,
// or `store.set(s => ({ chats: ...s.chats }))` lets the updater see the
// current state. Listeners run synchronously after each update, so be
// careful inside listeners not to call `set` again unconditionally
// (would recurse).

import type { Capabilities } from '../graph/capabilities'
import type { Me } from '../graph/me'
import type {
  Channel,
  Chat,
  ChatMessage,
  Presence,
  Team,
} from '../types'

export type Listener<S> = (state: S) => void

export class Store<S extends object> {
  private state: S
  private listeners = new Set<Listener<S>>()

  constructor(initial: S) {
    this.state = initial
  }

  get(): S {
    return this.state
  }

  set(input: Partial<S> | ((s: S) => Partial<S>)): void {
    const patch = typeof input === 'function' ? input(this.state) : input
    if (patch === this.state) return
    let changed = false
    const next = { ...this.state }
    for (const key of Object.keys(patch) as (keyof S)[]) {
      const v = patch[key]
      if (v !== undefined && v !== this.state[key]) {
        next[key] = v as S[typeof key]
        changed = true
      }
    }
    if (!changed) return
    this.state = next
    for (const l of this.listeners) l(this.state)
  }

  subscribe(listener: Listener<S>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export type FocusList = { kind: 'list' }
export type FocusChat = { kind: 'chat'; chatId: string }
export type FocusChannel = { kind: 'channel'; teamId: string; channelId: string }
export type Focus = FocusList | FocusChat | FocusChannel

export type ConvKey = string

// Stable string key per active conversation, used to index seen-set,
// messagesByConvo, etc. Returns null when nothing is actively focused.
export function focusKey(focus: Focus): ConvKey | null {
  switch (focus.kind) {
    case 'list':
      return null
    case 'chat':
      return `chat:${focus.chatId}`
    case 'channel':
      return `channel:${focus.teamId}:${focus.channelId}`
  }
}

export type ConnectionState =
  | 'connecting'
  | 'online'
  | 'offline'
  | 'authError'
  | 'rateLimited'

export type AppState = {
  me?: Me
  capabilities?: Capabilities
  chats: Chat[]
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
  messagesByConvo: Record<ConvKey, ChatMessage[]>
  focus: Focus
  // Cursor index over the flat selectable list (chats, then teams + their
  // channels). The selectable list is computed on demand from chats + teams
  // + channelsByTeam; the cursor is bounded against it at render time so
  // a stale value is not a bug, just a clamp.
  cursor: number
  myPresence?: Presence
  // Keyed by user id, populated only for currently visible chat members.
  memberPresence: Record<string, Presence>
  conn: ConnectionState
}

export function initialAppState(): AppState {
  return {
    chats: [],
    teams: [],
    channelsByTeam: {},
    messagesByConvo: {},
    focus: { kind: 'list' },
    cursor: 0,
    memberPresence: {},
    conn: 'connecting',
  }
}

export function createAppStore(): Store<AppState> {
  return new Store<AppState>(initialAppState())
}
