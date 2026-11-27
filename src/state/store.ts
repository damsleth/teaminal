// Tiny pub/sub store. No external dependency.
//
// Patch-style updates: `store.set({ chats: nextChats })` shallow-merges,
// or `store.set(s => ({ chats: ...s.chats }))` lets the updater see the
// current state. Listeners run synchronously after each update, so be
// careful inside listeners not to call `set` again unconditionally
// (would recurse).

import type { AccountId, AccountRef } from '../account'
import type { Capabilities } from '../graph/capabilities'
import type { Me } from '../graph/me'
import type { ForceAvailabilityValue as PresenceChoice } from '../graph/teamsPresence'
import type { ActivityItem } from '../graph/teamsActivity'
import type { Channel, Chat, ChatMessage, LastMessagePreview, Presence, Team } from '../types'
import type { InlineImageRef } from '../text/inlineImages'
import { defaultSettings, type Settings, type SystemAppearance } from '../settings'

// Settings live in src/settings (layer-neutral); re-exported for importers
// of the store.
export * from '../settings'

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

  /**
   * Replace the entire state object. Used by resetAccountScopedState
   * when switching profiles, where 'partial merge with undefined =
   * ignore' semantics of set() would leave stale me / capabilities /
   * myPresence on the next account.
   */
  replace(next: S): void {
    if (next === this.state) return
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
export type FocusThread = {
  kind: 'thread'
  teamId: string
  channelId: string
  rootId: string
}
export type Focus = FocusList | FocusChat | FocusChannel | FocusThread

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
    case 'thread':
      return `thread:${focus.teamId}:${focus.channelId}:${focus.rootId}`
  }
}

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'authError' | 'rateLimited'

// Where keystrokes are routed when the App's useInput fires.
//   list     - cursor navigation in ChatList
//   composer - text editing in Composer
//   filter   - typing into the chat-list filter buffer
//   menu     - navigating the modal pause-menu (MenuModal owns input)
//   resize   - transient pane-resize mode (Ctrl-X from list)
// Distinct from `focus` (which conv is open).
export type InputZone = 'list' | 'composer' | 'filter' | 'menu' | 'message-search' | 'resize'

// Active modal overlay. When set, App renders the modal in the central pane
// area (replacing chat list + message pane) and inputZone is 'menu'. Add
// new `kind` variants here when introducing more modal surfaces.
export type ModalState =
  | { kind: 'menu'; path: string[]; cursor: number }
  // Live theme/layout editor. `cursor` indexes into the flat editable-field
  // list (src/ui/themeEditor.ts); the per-field hex-entry buffer lives in the
  // component's local state, not here.
  | { kind: 'theme-editor'; cursor: number }
  // Theme presets list (save / save as / load / delete). `prompt` is the
  // name being typed for Save as; `confirmDelete` arms the delete key;
  // `returnTo` is where esc goes back to.
  | {
      kind: 'theme-presets'
      cursor: number
      returnTo: 'menu' | 'theme-editor'
      prompt: string | null
      confirmDelete: boolean
      message: string | null
    }
  | { kind: 'keybinds' }
  | { kind: 'diagnostics' }
  | { kind: 'events' }
  | { kind: 'network' }
  | { kind: 'activity'; cursor: number }
  // Set / clear the status message (message + end time); the field text
  // lives in the component's local state.
  | { kind: 'status-note' }
  // Tenant-wide server-side message search (Microsoft Search API). The
  // query / results / cursor live in the modal component's local state.
  | { kind: 'message-search-global' }
  // Command palette (Ctrl+P); query and cursor live in the component.
  | { kind: 'command-palette'; returnTo?: InputZone }
  // Context menu ('.' / Ctrl+.) for a chat-list row or a message.
  | {
      kind: 'context-menu'
      target:
        // alias: the row's account in the unified sidebar (absent = foreground).
        | { kind: 'chat'; chatId: string; label: string; alias?: string }
        | { kind: 'channel'; teamId: string; channelId: string; label: string; alias?: string }
        | { kind: 'message'; focus: FocusChat | FocusChannel; messageId: string }
      cursor: number
    }
  // Reaction picker for the focused chat message. Delegates to the macOS
  // system emoji picker and captures the glyph it inserts (see
  // ReactionPickerModal); toggleReaction resolves the existing reaction itself.
  | { kind: 'reaction-picker'; chatId: string; messageId: string }
  // Confirm before soft-deleting the user's own chat message. `preview` is a
  // short excerpt of the message body for the prompt.
  | { kind: 'confirm-delete'; chatId: string; messageId: string; preview: string }
  // alias: the chat's account in the unified sidebar (absent = foreground).
  | { kind: 'confirm-delete-chat'; chatId: string; label: string; alias?: string }
  // Full-size view of a focused inline image. Carries the InlineImageRef so
  // the modal can resolve the cached blob (or fetch it on open).
  | { kind: 'image'; ref: InlineImageRef }
  // Edit-reactions overlay: lists the current user's reactions on a message
  // so they can remove individual ones with j/k to move, x/Enter to remove.
  | { kind: 'edit-reactions'; chatId: string; messageId: string }
  | AccountManagerModalState
  | AuthExpiredModalState

export type AuthExpiredModalState = {
  kind: 'auth-expired'
  profile: string | null
  message: string
  // 'idle' = waiting for user choice; 'reseeding' = subprocess in flight;
  // 'retrying' = reseed succeeded, runSession is being kicked off.
  status: 'idle' | 'reseeding' | 'retrying'
  lastError?: string
}

export type AccountManagerAccount = {
  id: string
  label: string
  profile?: string
  active?: boolean
}

export type AccountManagerModalState =
  | {
      kind: 'accounts'
      mode: 'list'
      cursor: number
      accounts: AccountManagerAccount[]
      error?: string
    }
  | {
      kind: 'accounts'
      mode: 'add'
      alias: string
      error?: string
    }
  | {
      kind: 'accounts'
      mode: 'remove'
      cursor: number
      accounts: AccountManagerAccount[]
      error?: string
    }

export type MessageCache = {
  messages: ChatMessage[]
  nextLink?: string
  loadingOlder: boolean
  fullyLoaded: boolean
  error?: string
  // Lets message-pane integration preserve its visual anchor after older
  // rows are prepended.
  lastOlderLoad?: {
    beforeFirstId?: string
    addedCount: number
  }
}

export type ChatUnreadActivity = {
  lastSeenPreviewId?: string
  unreadCount: number
  mentionCount: number
  lastSenderName?: string
  lastActivityAt?: string
}

export type UnreadTotals = {
  unreadCount: number
  mentionCount: number
  chats: number
}

export function emptyMessageCache(messages: ChatMessage[] = []): MessageCache {
  return {
    messages,
    loadingOlder: false,
    fullyLoaded: false,
  }
}

export function messagesFromCaches(
  caches: Record<ConvKey, MessageCache>,
): Record<ConvKey, ChatMessage[]> {
  const out: Record<ConvKey, ChatMessage[]> = {}
  for (const [conv, cache] of Object.entries(caches)) out[conv] = cache.messages
  return out
}

export function cacheMessagesFromLegacy(
  messagesByConvo: Record<ConvKey, ChatMessage[]>,
): Record<ConvKey, MessageCache> {
  const out: Record<ConvKey, MessageCache> = {}
  for (const [conv, messages] of Object.entries(messagesByConvo)) {
    out[conv] = emptyMessageCache(messages)
  }
  return out
}

function previewSenderName(preview?: LastMessagePreview | null): string | undefined {
  return preview?.from?.user?.displayName ?? undefined
}

function previewActivityAt(preview?: LastMessagePreview | null): string | undefined {
  return preview?.createdDateTime ?? undefined
}

export function seedChatActivity(
  activityByChatId: Record<string, ChatUnreadActivity>,
  chats: Chat[],
): Record<string, ChatUnreadActivity> {
  const next = { ...activityByChatId }
  for (const chat of chats) {
    const preview = chat.lastMessagePreview
    next[chat.id] = {
      ...(next[chat.id] ?? { unreadCount: 0, mentionCount: 0 }),
      lastSeenPreviewId: preview?.id ?? next[chat.id]?.lastSeenPreviewId,
      unreadCount: 0,
      mentionCount: 0,
      lastSenderName: previewSenderName(preview) ?? next[chat.id]?.lastSenderName,
      lastActivityAt: previewActivityAt(preview) ?? next[chat.id]?.lastActivityAt,
    }
  }
  return next
}

export function markChatRead(
  activityByChatId: Record<string, ChatUnreadActivity>,
  chatId: string,
  lastSeenPreviewId?: string,
): Record<string, ChatUnreadActivity> {
  const prev = activityByChatId[chatId]
  const nextSeen = lastSeenPreviewId ?? prev?.lastSeenPreviewId
  // Identity-preserving on a no-op: the active loop calls this on every poll
  // of a focused chat, so returning a fresh object would notify every store
  // subscriber even when the chat was already read at this preview id.
  if (
    prev &&
    prev.unreadCount === 0 &&
    prev.mentionCount === 0 &&
    prev.lastSeenPreviewId === nextSeen
  ) {
    return activityByChatId
  }
  return {
    ...activityByChatId,
    [chatId]: {
      ...(prev ?? { unreadCount: 0, mentionCount: 0 }),
      lastSeenPreviewId: nextSeen,
      unreadCount: 0,
      mentionCount: 0,
    },
  }
}

export function markChatUnread(
  activityByChatId: Record<string, ChatUnreadActivity>,
  chat: Chat,
): Record<string, ChatUnreadActivity> {
  const preview = chat.lastMessagePreview
  const prev = activityByChatId[chat.id]
  return {
    ...activityByChatId,
    [chat.id]: {
      ...(prev ?? { unreadCount: 0, mentionCount: 0 }),
      lastSeenPreviewId: prev?.lastSeenPreviewId,
      unreadCount: (prev?.unreadCount ?? 0) + 1,
      mentionCount: prev?.mentionCount ?? 0,
      lastSenderName: previewSenderName(preview) ?? prev?.lastSenderName,
      lastActivityAt: previewActivityAt(preview) ?? prev?.lastActivityAt,
    },
  }
}

/**
 * Manually toggle a chat's unread state. If the chat currently has
 * unread or mentions, clear them (mark read). Otherwise set
 * unreadCount to 1 so the chat shows in the unread count and the
 * sidebar gets the unread badge.
 *
 * Used by the `m` keybind in the chat list to flip a chat's read state.
 */
export function toggleChatUnread(
  activityByChatId: Record<string, ChatUnreadActivity>,
  chat: Chat,
): Record<string, ChatUnreadActivity> {
  const prev = activityByChatId[chat.id]
  const isUnread = !!prev && (prev.unreadCount > 0 || prev.mentionCount > 0)
  if (isUnread) {
    return markChatRead(activityByChatId, chat.id)
  }
  const preview = chat.lastMessagePreview
  return {
    ...activityByChatId,
    [chat.id]: {
      ...(prev ?? { unreadCount: 0, mentionCount: 0 }),
      lastSeenPreviewId: prev?.lastSeenPreviewId,
      unreadCount: 1,
      mentionCount: 0,
      lastSenderName: previewSenderName(preview) ?? prev?.lastSenderName,
      lastActivityAt: previewActivityAt(preview) ?? prev?.lastActivityAt,
    },
  }
}

export function bumpChatMention(
  activityByChatId: Record<string, ChatUnreadActivity>,
  chatId: string,
): Record<string, ChatUnreadActivity> {
  const prev = activityByChatId[chatId]
  return {
    ...activityByChatId,
    [chatId]: {
      ...(prev ?? { unreadCount: 0, mentionCount: 0 }),
      mentionCount: (prev?.mentionCount ?? 0) + 1,
    },
  }
}

export function unreadTotals(activityByChatId: Record<string, ChatUnreadActivity>): UnreadTotals {
  let unreadCount = 0
  let mentionCount = 0
  let chats = 0
  for (const activity of Object.values(activityByChatId)) {
    unreadCount += activity.unreadCount
    mentionCount += activity.mentionCount
    if (activity.unreadCount > 0 || activity.mentionCount > 0) chats++
  }
  return { unreadCount, mentionCount, chats }
}

// What an account has to say in the header badge and the Accounts modal:
// chats with unread activity plus unread activity-feed mentions.
export function accountUnreadCount(
  s: Pick<AccountSlice, 'unreadByChatId' | 'unreadMentionCount'>,
): number {
  return unreadTotals(s.unreadByChatId).chats + s.unreadMentionCount
}

export function recentUnreadNotifications(
  activityByChatId: Record<string, ChatUnreadActivity>,
  limit = 5,
): (ChatUnreadActivity & { chatId: string })[] {
  return Object.entries(activityByChatId)
    .filter(([, activity]) => activity.unreadCount > 0 || activity.mentionCount > 0)
    .map(([chatId, activity]) => ({ chatId, ...activity }))
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
    .slice(0, limit)
}

export function clampMessageCursor(cursor: number, messageCount: number): number {
  if (messageCount <= 0) return 0
  if (!Number.isFinite(cursor)) return messageCount - 1
  return Math.max(0, Math.min(messageCount - 1, Math.trunc(cursor)))
}

export function moveMessageCursor(
  cursor: number | undefined,
  delta: number,
  messageCount: number,
): number {
  const start = cursor === undefined ? messageCount - 1 : cursor
  return clampMessageCursor(start + delta, messageCount)
}

export function setMessageCursor(
  cursors: Record<ConvKey, number>,
  conv: ConvKey,
  cursor: number,
  messageCount: number,
): Record<ConvKey, number> {
  return {
    ...cursors,
    [conv]: clampMessageCursor(cursor, messageCount),
  }
}

// Real-time transport connection state, shown in the header bar.
export type RealtimeState = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'

// Per-user typing indicator with expiry timestamp.
export type TypingIndicator = {
  userId: string
  displayName: string
  /** Date.now() when the indicator was last refreshed. */
  startedAt: number
}

export type ReadReceipt = {
  userId: string
  messageId: string
  seenAt: number
}

// List-pane UI an account gets back when it returns to the foreground.
export type AccountUi = { focus: Focus; cursor: number; cursorKey: string | null }

export type AppState = {
  // The foreground account: the one whose data the flat per-account fields
  // below hold. Other open accounts live in backgroundAccounts.
  account: AccountRef | null
  // Monotonic counter every opened account slot draws its generation from.
  accountGeneration: number
  // Open account slots (foreground included) -> their generation. An
  // AccountStore handle is current while its slot keeps the generation it
  // captured, so a closed or re-opened account drops late writes.
  generationById: Record<AccountId, number>
  // Account slices of the open accounts that are not in the foreground.
  backgroundAccounts: Record<AccountId, AccountState>
  // Saved focus / list cursor of accounts swapped out of the foreground.
  uiByAccount: Record<AccountId, AccountUi>
  me?: Me
  capabilities?: Capabilities
  chats: Chat[]
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
  messageCacheByConvo: Record<ConvKey, MessageCache>
  // Compatibility mirror for UI/composer code that has not moved to
  // messageCacheByConvo yet.
  messagesByConvo: Record<ConvKey, ChatMessage[]>
  // Per-conversation composer drafts. Cleared on successful send;
  // preserved across focus switches so a half-typed reply isn't lost.
  draftsByConvo: Record<ConvKey, string>
  unreadByChatId: Record<string, ChatUnreadActivity>
  focus: Focus
  inputZone: InputZone
  messageCursorByConvo: Record<ConvKey, number>
  // Cursor index over the flat selectable list (chats, then teams + their
  // channels). The selectable list is computed on demand from chats + teams
  // + channelsByTeam; the cursor is bounded against it at render time so
  // a stale value is not a bug, just a clamp.
  // `cursorKey` (selectableKey of the row) is what the cursor follows: list
  // refreshes reorder rows, so readers resolve the key first and fall back to
  // the `cursor` index only when that row went away. Set both via cursorAt().
  cursor: number
  cursorKey: string | null
  // Focus within the message under the pane cursor. 0 = the message body;
  // > 0 indexes into that message's attachments (images then links), per
  // src/ui/messageFocusables.ts. Reset to 0 whenever the message cursor or
  // conversation changes.
  focusedAttachmentIndex: number
  // Case-insensitive substring filter applied to the chat list. Empty
  // string means no filter.
  filter: string
  // Grouped chat sections the user expanded past CHAT_SECTION_CAP via the
  // `… N more` row. Ephemeral: a fresh session starts capped again.
  expandedChatSections: Record<string, boolean>
  // Ctrl+B hides the chat list: list and conversation then share one pane,
  // showing whichever has focus (h/Left reveals the list, l/Right opens the
  // chat). Ephemeral.
  chatListCollapsed: boolean
  // In-conversation message search (S1). Empty query closes the bar.
  // focusedHitMessageId tracks the message the search bar last jumped
  // to so n can step relative to it across re-renders.
  messageSearchQuery: string
  messageSearchFocusedId: string | null
  myPresence?: Presence
  // Keyed by user id, populated only for currently visible chat members.
  memberPresence: Record<string, Presence>
  conn: ConnectionState
  // Real-time push transport state. 'off' when not configured or not
  // attempted; other values reflect the trouter/SSE connection lifecycle.
  realtimeState: RealtimeState
  // True while the terminal window has input focus, per DEC focus
  // reporting (CSI ?1004). Drives the force-availability driver.
  // Defaults to true (process startup implies focus); set to false
  // when the terminal sends ESC[O and back to true on ESC[I.
  terminalFocused: boolean
  // True when at least one DEC 1004 focus event has been observed
  // (or DEC reporting is presumed healthy by the fallback timer).
  // Surfaces in the Diagnostics modal so users on terminals that
  // drop DEC 1004 (some Ghostty versions, certain multiplexers)
  // can see why force-availability behavior may differ. While
  // false, the force-availability driver still treats the terminal
  // as focused so the override does not silently disable.
  focusReportingHealthy: boolean
  // The presence the user picked (menu / palette). Session-only: teaminal
  // resets to Available on exit. Anything but Available is held even while
  // the terminal is blurred; Available follows forceAvailableWhenFocused.
  presenceChoice: PresenceChoice
  // Active typing indicators per conversation, keyed by ConvKey.
  // Entries expire after ~8s of inactivity (cleaned by a timer).
  typingByConvo: Record<ConvKey, TypingIndicator[]>
  // Latest read position per user, per conversation. Push events only
  // tell us what message each user has read up to; rendering code maps
  // those positions to "seen by N" lines under matching self messages.
  readReceiptsByConvo: Record<ConvKey, Record<string, ReadReceipt>>
  // Active modal overlay (e.g. pause menu). null = no modal.
  modal: ModalState | null
  // Id of the chat message currently being edited in the composer, or null
  // when composing a new message. Set by the chat-zone `e` key; cleared on
  // send or cancel. Editing is gated to the user's own chat messages.
  editingMessageId: string | null
  // Custom theme loaded from ~/.config/teaminal/themes/<name>.json when
  // settings.theme is not a built-in name. Layered between the built-in
  // base ('dark') and settings.themeOverrides during theme resolution.
  // Loaded once at startup by bin/teaminal.tsx; null when the startup
  // theme is a built-in or when the file is missing/invalid. The name
  // is stored with the data so cycling away from a custom theme cannot
  // accidentally keep applying its tokens to built-in themes.
  customTheme: { name: string; data: Record<string, unknown> } | null
  // Current OS appearance, detected by startSystemAppearanceDriver. Drives
  // the 'auto' theme (settings.theme === 'auto' resolves to this). Not
  // account-scoped — it's a machine-level fact preserved across switches.
  systemAppearance: SystemAppearance
  // User-tunable display preferences. Persisted to disk via
  // src/config/index.ts (loadSettings/saveSettings/updateSettings).
  settings: Settings
  // Wall-clock timestamp of the last successful list-poll. Drives the
  // "updated Ns ago" hint in the StatusBar; undefined while we have not
  // yet completed an initial poll.
  lastListPollAt?: Date
  // CSA activity feed (bell-icon panel in Teams web). Hydrated once on
  // launch and reconciled with trouter push events. Newest item first.
  activityFeed: ActivityItem[]
  // Server-derived count of unread @mentions across the whole tenant
  // (includes channel mentions in teams the user hasn't opened yet,
  // which unreadByChatId can't reach). Cleared as items are marked read.
  unreadMentionCount: number
  // Opaque CSA pagination cursor; sent on the next /updates call.
  activitySyncState?: string | undefined
  // userId -> resolved full display name, harvested from message senders
  // and lastMessagePreview. Lets chatLabel recover a real name for chat
  // members whose Graph roster displayName is missing ("(unknown)") or is
  // just the email address. Built by src/state/nameIndex.ts and persisted
  // per-profile via nameCachePersistence.ts.
  nameByUserId: Record<string, string>
}

// Fields owned by one account. Everything else in AppState is global UI or
// environment state (GlobalKey). The check below fails to compile when a new
// AppState field is not classified as one or the other.
export const ACCOUNT_KEYS = [
  'me',
  'capabilities',
  'chats',
  'teams',
  'channelsByTeam',
  'messageCacheByConvo',
  'messagesByConvo',
  'draftsByConvo',
  'messageCursorByConvo',
  'unreadByChatId',
  'expandedChatSections',
  'myPresence',
  'memberPresence',
  'conn',
  'realtimeState',
  'typingByConvo',
  'readReceiptsByConvo',
  'lastListPollAt',
  'activityFeed',
  'unreadMentionCount',
  'activitySyncState',
  'nameByUserId',
] as const satisfies readonly (keyof AppState)[]

export type AccountKey = (typeof ACCOUNT_KEYS)[number]
export type GlobalKey =
  | 'account'
  | 'accountGeneration'
  | 'generationById'
  | 'backgroundAccounts'
  | 'uiByAccount'
  // UI
  | 'focus'
  | 'inputZone'
  | 'cursor'
  | 'cursorKey'
  | 'focusedAttachmentIndex'
  | 'filter'
  | 'chatListCollapsed'
  | 'messageSearchQuery'
  | 'messageSearchFocusedId'
  | 'modal'
  | 'editingMessageId'
  // environment
  | 'terminalFocused'
  | 'focusReportingHealthy'
  | 'presenceChoice'
  | 'customTheme'
  | 'systemAppearance'
  | 'settings'
const _everyKeyClassified: [Exclude<keyof AppState, AccountKey | GlobalKey>] extends [never]
  ? true
  : never = true
const _noKeyInBoth: [Extract<AccountKey, GlobalKey>] extends [never] ? true : never = true
void _everyKeyClassified
void _noKeyInBoth

export type AccountSlice = Pick<AppState, AccountKey>
export type AccountState = AccountSlice & { ref: AccountRef }

export function initialAccountState(ref: AccountRef): AccountState {
  const fresh = initialAppState()
  const out = { ref } as AccountState
  for (const k of ACCOUNT_KEYS) (out as Record<string, unknown>)[k] = fresh[k]
  return out
}

// Every account key present, undefined included: a swap that spreads this
// over the flat fields must clear an optional key (me, myPresence, ...) the
// outgoing account had set.
export function pickAccountSlice(s: AccountSlice): AccountSlice {
  const out = {} as AccountSlice
  for (const k of ACCOUNT_KEYS) (out as Record<string, unknown>)[k] = s[k]
  return out
}

// Account `id`'s data: the flat fields when it is in the foreground, its
// background slice otherwise, undefined when it is not open.
export function accountSlice(s: AppState, id: AccountId): AccountSlice | undefined {
  return s.account?.id === id ? s : s.backgroundAccounts[id]
}

export function initialAppState(): AppState {
  return {
    account: null,
    accountGeneration: 0,
    generationById: {},
    backgroundAccounts: {},
    uiByAccount: {},
    chats: [],
    teams: [],
    channelsByTeam: {},
    messageCacheByConvo: {},
    messagesByConvo: {},
    draftsByConvo: {},
    unreadByChatId: {},
    focus: { kind: 'list' },
    inputZone: 'list',
    messageCursorByConvo: {},
    cursor: 0,
    cursorKey: null,
    focusedAttachmentIndex: 0,
    filter: '',
    expandedChatSections: {},
    chatListCollapsed: false,
    messageSearchQuery: '',
    messageSearchFocusedId: null,
    memberPresence: {},
    conn: 'connecting',
    realtimeState: 'off',
    terminalFocused: true,
    focusReportingHealthy: false,
    presenceChoice: 'Available',
    typingByConvo: {},
    readReceiptsByConvo: {},
    modal: null,
    editingMessageId: null,
    customTheme: null,
    systemAppearance: 'dark',
    settings: { ...defaultSettings },
    activityFeed: [],
    unreadMentionCount: 0,
    nameByUserId: {},
  }
}

export function createAppStore(account: AccountRef | null = null): Store<AppState> {
  const generationById: Record<AccountId, number> = {}
  if (account) generationById[account.id] = 0
  return new Store<AppState>({ ...initialAppState(), account, generationById })
}

/**
 * Wipe the account-scoped slices of the store while preserving
 * settings (theme / notifications / window height) and the
 * terminal-focused flag (which is a hardware-level fact, not a
 * per-account fact).
 *
 * Used when switching the active owa-piggy profile: the new account
 * has its own me/chats/teams/messages and re-fetches them from scratch,
 * but the user's UI preferences should persist across the switch. Closes
 * every open account slot and opens `account` as the only (foreground) one
 * with a fresh generation, so every accountStore() captured before the reset
 * goes stale. One replace, so subscribers see a single change.
 */
export function resetAccountScopedState(store: Store<AppState>, account: AccountRef): void {
  const prev = store.get()
  const fresh = initialAppState()
  fresh.account = account
  fresh.accountGeneration = prev.accountGeneration + 1
  fresh.generationById[account.id] = fresh.accountGeneration
  // Preserve UI preferences and hardware-level state.
  fresh.settings = prev.settings
  fresh.terminalFocused = prev.terminalFocused
  fresh.focusReportingHealthy = prev.focusReportingHealthy
  fresh.presenceChoice = prev.presenceChoice
  fresh.systemAppearance = prev.systemAppearance
  fresh.customTheme = prev.customTheme
  store.replace(fresh)
}
