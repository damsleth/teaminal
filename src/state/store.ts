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

// Where keystrokes are routed when the App's useInput fires.
//   list     - cursor navigation in ChatList
//   composer - text editing in Composer
//   filter   - typing into the chat-list filter buffer
//   menu     - navigating the modal pause-menu (MenuModal owns input)
// Distinct from `focus` (which conv is open).
export type InputZone = 'list' | 'composer' | 'filter' | 'menu'

// Active modal overlay. When set, App renders the modal in the central pane
// area (replacing chat list + message pane) and inputZone is 'menu'. Add
// new `kind` variants here when introducing more modal surfaces.
export type ModalState =
  | { kind: 'menu'; path: string[]; cursor: number }
  | { kind: 'keybinds' }
  | { kind: 'diagnostics' }

export type ThemeMode = 'dark' | 'light'
export type ChatListDensity = 'cozy' | 'compact'

// Window height is the number of terminal rows teaminal renders into.
// 0 is the sentinel for "fill the terminal" (height="100%"). The menu
// cycles through a small preset list; bespoke values can be added by
// extending WINDOW_HEIGHT_PRESETS in src/ui/menu.ts.
export type WindowHeight = number

export type Settings = {
  theme: ThemeMode
  chatListDensity: ChatListDensity
  // When true, sidebar chat rows render the first name only ("Finn",
  // "Anna, Bjorn, +1") instead of the full corporate-AD form
  // ("Nordling, Finn Saethre"). The MessagePane header always uses the
  // full form regardless. Default false (full names) so disambiguation
  // is preserved out of the box; users with mostly-internal contacts
  // can flip this on.
  chatListShortNames: boolean
  showPresenceInList: boolean
  showTimestampsInPane: boolean
  windowHeight: WindowHeight
}

export const defaultSettings: Settings = {
  theme: 'dark',
  chatListDensity: 'cozy',
  chatListShortNames: false,
  showPresenceInList: true,
  showTimestampsInPane: true,
  windowHeight: 0,
}

export type AppState = {
  me?: Me
  capabilities?: Capabilities
  chats: Chat[]
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
  messagesByConvo: Record<ConvKey, ChatMessage[]>
  focus: Focus
  inputZone: InputZone
  // Cursor index over the flat selectable list (chats, then teams + their
  // channels). The selectable list is computed on demand from chats + teams
  // + channelsByTeam; the cursor is bounded against it at render time so
  // a stale value is not a bug, just a clamp.
  cursor: number
  // Case-insensitive substring filter applied to the chat list. Empty
  // string means no filter.
  filter: string
  myPresence?: Presence
  // Keyed by user id, populated only for currently visible chat members.
  memberPresence: Record<string, Presence>
  conn: ConnectionState
  // Active modal overlay (e.g. pause menu). null = no modal.
  modal: ModalState | null
  // User-tunable display preferences. Persisted to disk later (TODO);
  // for now just in-process.
  settings: Settings
  // Wall-clock timestamp of the last successful list-poll. Drives the
  // "updated Ns ago" hint in the StatusBar; undefined while we have not
  // yet completed an initial poll.
  lastListPollAt?: Date
}

export function initialAppState(): AppState {
  return {
    chats: [],
    teams: [],
    channelsByTeam: {},
    messagesByConvo: {},
    focus: { kind: 'list' },
    inputZone: 'list',
    cursor: 0,
    filter: '',
    memberPresence: {},
    conn: 'connecting',
    modal: null,
    settings: { ...defaultSettings },
  }
}

export function createAppStore(): Store<AppState> {
  return new Store<AppState>(initialAppState())
}
