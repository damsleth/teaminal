// Tiny pub/sub store. No external dependency.
//
// Patch-style updates: `store.set({ chats: nextChats })` shallow-merges,
// or `store.set(s => ({ chats: ...s.chats }))` lets the updater see the
// current state. Listeners run synchronously after each update, so be
// careful inside listeners not to call `set` again unconditionally
// (would recurse).

import type { Capabilities } from '../graph/capabilities'
import type { Me } from '../graph/me'
import type { Channel, Chat, ChatMessage, LastMessagePreview, Presence, Team } from '../types'

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
// Distinct from `focus` (which conv is open).
export type InputZone = 'list' | 'composer' | 'filter' | 'menu' | 'message-search'

// Active modal overlay. When set, App renders the modal in the central pane
// area (replacing chat list + message pane) and inputZone is 'menu'. Add
// new `kind` variants here when introducing more modal surfaces.
export type ModalState =
  | { kind: 'menu'; path: string[]; cursor: number }
  | { kind: 'keybinds' }
  | { kind: 'diagnostics' }
  | { kind: 'events' }
  | { kind: 'network' }
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

// Theme name. Built-in values are 'dark' | 'light' | 'compact' |
// 'comfortable'; any other string is treated as a user theme file under
// ~/.config/teaminal/themes/<name>.json. Kept as plain string here so
// the config validator stays the single source of truth.
export type ThemeMode = string
export type ChatListDensity = 'cozy' | 'compact'
export type BorderStyleName =
  | 'single'
  | 'double'
  | 'round'
  | 'bold'
  | 'classic'
  | 'singleDouble'
  | 'doubleSingle'
  | 'arrow'
export type ReactionDisplayMode = 'off' | 'current' | 'all'
export type ThemePresenceKey =
  | 'Available'
  | 'AvailableIdle'
  | 'Away'
  | 'BeRightBack'
  | 'Busy'
  | 'BusyIdle'
  | 'DoNotDisturb'
  | 'Offline'
  | 'OutOfOffice'
  | 'PresenceUnknown'

export type ThemeOverrides = {
  background?: string
  text?: string
  mutedText?: string
  border?: string
  borderActive?: string
  selected?: string
  selectedRow?: string
  unread?: string
  unreadRow?: string
  timestamp?: string
  sender?: string
  selfMessage?: string
  systemEvent?: string
  errorText?: string
  warnText?: string
  infoText?: string
  messageFocusIndicator?: string
  messageFocusBackground?: string | null
  presence?: Partial<Record<ThemePresenceKey, string>>
  layout?: Partial<{
    panePaddingX: number
    modalPaddingX: number
    modalPaddingY: number
    paneHeaderPaddingLeft: number
    paneHeaderMarginBottom: number
    tailGap: number
    chatListPaddingRight: number
  }>
  borders?: Partial<{
    panel: BorderStyleName
    modal: BorderStyleName
  }>
  emphasis?: Partial<{
    modalTitleBold: boolean
    sectionHeadingBold: boolean
    selectedBold: boolean
    unreadBold: boolean
    senderBold: boolean
    inlineKeyBold: boolean
  }>
}

export type Settings = {
  theme: ThemeMode
  themeOverrides: ThemeOverrides
  accounts: string[]
  activeAccount: string | null
  chatListDensity: ChatListDensity
  // When true, sidebar chat rows render the first name only ("Finn",
  // "Anna, Bjorn, +1") instead of the full corporate-AD form
  // ("Nordling, Finn Saethre"). The MessagePane header always uses the
  // full form regardless. Default false (full names) so disambiguation
  // is preserved out of the box; users with mostly-internal contacts
  // can flip this on.
  chatListShortNames: boolean
  // When true (default), the message pane renders the sender column as
  // first-name only ("Finn") instead of the full display name
  // ("Nordling, Finn Saethre"). Independent of `chatListShortNames` so
  // users can short-name one place and not the other.
  messagePaneShortNames: boolean
  showPresenceInList: boolean
  showTimestampsInPane: boolean
  showReactions: ReactionDisplayMode
  messageFocusIndicatorEnabled: boolean
  messageFocusIndicatorChar: string
  // null means "use the resolved theme default". Advanced users can set
  // explicit colors in config.json without forcing the menu to grow a
  // color-picker UI.
  messageFocusIndicatorColor: string | null
  messageFocusBackgroundColor: string | null
  // When true (default), the presence loop hits Teams unified presence
  // (presence.teams.microsoft.com) for own presence instead of Graph's
  // /me/presence. The Teams endpoint works under FOCI tokens whose Graph
  // audience does not carry the Presence.Read scope, and returns richer
  // info (deviceType, OOO, work-location). Falls back to Graph if the
  // Teams call fails with an auth error. Set false to force the Graph
  // path — useful in tenants where the public client is blocked from
  // talking to presence.teams.microsoft.com directly.
  useTeamsPresence: boolean
  // When true (default), teaminal PUTs forceavailability=Available to
  // presence.teams.microsoft.com while the terminal window has focus
  // (DEC focus reporting; CSI ?1004). The server expires the override
  // after ~5 min, so the driver refreshes inside that window. On blur
  // the override is left to decay naturally. Set false to leave
  // presence to Teams' own desktop client / inactivity timer.
  forceAvailableWhenFocused: boolean
  // Experimental Teams push transport. Disabled by default because the
  // undocumented trouter WebSocket upgrade is tenant/protocol-sensitive;
  // polling remains the durable path when this is off or errors.
  realtimeEnabled: boolean
  // Notification preferences. notifyMuted is a session-level kill switch
  // that suppresses banners (bell still rings — terminal-level mute is
  // the user's responsibility). notifyActiveBanner forces the banner
  // even when the user is already viewing the active conv (default off:
  // bell only). quietHoursStart/End are HH:MM strings or null to disable.
  notifyMuted: boolean
  notifyActiveBanner: boolean
  quietHoursStart: string | null
  quietHoursEnd: string | null
  // Optional path for the redacted stderr mirror. CLI --log-file
  // overrides this. null disables the mirror.
  logFile: string | null
  // Always-on diagnostics tails rendered as 1/3-width strips above the
  // composer. Independent of the modal versions of the same panels.
  tailEvents: boolean
  tailNetwork: boolean
  tailDiagnostics: boolean
  // When true, messages from the current user are right-aligned in the
  // message pane (body on the right, sender on the left of body). Other
  // users' messages remain left-aligned. Default false (IRC-style uniform
  // left alignment).
  selfMessagesOnRight: boolean
  // Inline image rendering for message attachments.
  // 'auto': show images via Kitty graphics protocol when the terminal
  //   supports it (KITTY_WINDOW_ID / TERM=xterm-kitty); fall back to
  //   compact text row otherwise.
  // 'off': always show the text fallback, even in Kitty terminals.
  inlineImages: 'auto' | 'off'
  // Maximum terminal rows a single inline image may occupy. Images taller
  // than this are scaled down by the terminal to fit. Default 10.
  inlineImageMaxRows: number
}

export const defaultSettings: Settings = {
  theme: 'dark',
  themeOverrides: {},
  accounts: [],
  activeAccount: null,
  chatListDensity: 'cozy',
  chatListShortNames: false,
  messagePaneShortNames: true,
  showPresenceInList: true,
  showTimestampsInPane: true,
  showReactions: 'current',
  messageFocusIndicatorEnabled: true,
  messageFocusIndicatorChar: '>',
  messageFocusIndicatorColor: null,
  messageFocusBackgroundColor: null,
  useTeamsPresence: true,
  forceAvailableWhenFocused: true,
  realtimeEnabled: false,
  notifyMuted: false,
  notifyActiveBanner: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  logFile: null,
  tailEvents: false,
  tailNetwork: false,
  tailDiagnostics: false,
  selfMessagesOnRight: false,
  inlineImages: 'auto',
  inlineImageMaxRows: 10,
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
  return {
    ...activityByChatId,
    [chatId]: {
      ...(prev ?? { unreadCount: 0, mentionCount: 0 }),
      lastSeenPreviewId: lastSeenPreviewId ?? prev?.lastSeenPreviewId,
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

// Per-root metadata for channel reply badging. Populated opportunistically
// by the active-loop after a channel page lands. count is the number of
// replies actually returned by the replies endpoint; if more pages exist,
// `more` is true (we cap fetches at one page to keep the cost bounded).
export type ThreadMeta = {
  count: number
  more: boolean
  checkedAt: number
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

export type AppState = {
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
  cursor: number
  // Case-insensitive substring filter applied to the chat list. Empty
  // string means no filter.
  filter: string
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
  // Active typing indicators per conversation, keyed by ConvKey.
  // Entries expire after ~8s of inactivity (cleaned by a timer).
  typingByConvo: Record<ConvKey, TypingIndicator[]>
  // Latest read position per user, per conversation. Push events only
  // tell us what message each user has read up to; rendering code maps
  // those positions to "seen by N" lines under matching self messages.
  readReceiptsByConvo: Record<ConvKey, Record<string, ReadReceipt>>
  // Reply-count metadata for channel root messages, keyed by root id.
  // Populated opportunistically when the user has a channel focused;
  // missing entries simply render no badge.
  threadMetaByRoot: Record<string, ThreadMeta>
  // Active modal overlay (e.g. pause menu). null = no modal.
  modal: ModalState | null
  // Custom theme loaded from ~/.config/teaminal/themes/<name>.json when
  // settings.theme is not a built-in name. Layered between the built-in
  // base ('dark') and settings.themeOverrides during theme resolution.
  // Loaded once at startup by bin/teaminal.tsx; null when the startup
  // theme is a built-in or when the file is missing/invalid. The name
  // is stored with the data so cycling away from a custom theme cannot
  // accidentally keep applying its tokens to built-in themes.
  customTheme: { name: string; data: Record<string, unknown> } | null
  // User-tunable display preferences. Persisted to disk via
  // src/config/index.ts (loadSettings/saveSettings/updateSettings).
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
    messageCacheByConvo: {},
    messagesByConvo: {},
    draftsByConvo: {},
    unreadByChatId: {},
    focus: { kind: 'list' },
    inputZone: 'list',
    messageCursorByConvo: {},
    cursor: 0,
    filter: '',
    messageSearchQuery: '',
    messageSearchFocusedId: null,
    memberPresence: {},
    conn: 'connecting',
    realtimeState: 'off',
    terminalFocused: true,
    focusReportingHealthy: false,
    typingByConvo: {},
    readReceiptsByConvo: {},
    threadMetaByRoot: {},
    modal: null,
    customTheme: null,
    settings: { ...defaultSettings },
  }
}

export function createAppStore(): Store<AppState> {
  return new Store<AppState>(initialAppState())
}

/**
 * Wipe the account-scoped slices of the store while preserving
 * settings (theme / notifications / window height) and the
 * terminal-focused flag (which is a hardware-level fact, not a
 * per-account fact).
 *
 * Used when switching the active owa-piggy profile: the new account
 * has its own me/chats/teams/messages and re-fetches them from scratch,
 * but the user's UI preferences should persist across the switch.
 */
export function resetAccountScopedState(store: Store<AppState>): void {
  const prev = store.get()
  const fresh = initialAppState()
  // Preserve UI preferences and hardware-level state.
  fresh.settings = prev.settings
  fresh.terminalFocused = prev.terminalFocused
  fresh.focusReportingHealthy = prev.focusReportingHealthy
  store.replace(fresh)
}
