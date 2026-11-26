// User settings: the Settings shape, its defaults and the chat-routing
// helpers. Layer-neutral (imports nothing from the rest of src), so both
// src/config (load / validate / persist) and src/state (the live copy in
// the store) depend on it instead of config reaching into state.
//
// src/state/store.ts re-exports everything here, so existing imports from
// the store keep working.

// Theme name. Built-in values are 'auto' | 'dark' | 'light' ('auto'
// follows the OS appearance); any other string is treated as a user theme
// file under ~/.config/teaminal/themes/<name>.json. Kept as plain string
// here so the config validator stays the single source of truth.
export type ThemeMode = string
// Resolved OS appearance the 'auto' theme follows.
export type SystemAppearance = 'dark' | 'light'
export type BorderStyleName =
  | 'none'
  | 'single'
  | 'double'
  | 'round'
  | 'bold'
  | 'classic'
  | 'singleDouble'
  | 'doubleSingle'
  | 'arrow'
export type ReactionDisplayMode = 'off' | 'current' | 'all'

// Toggleable HeaderBar segments. The keys are also the HEADER_ELEMENT order
// used by the menu submenu. `app` controls the leading "teaminal" label; it
// used to be unconditional but is now toggleable like the rest.
export type HeaderElementVisibility = {
  app: boolean
  user: boolean
  presence: boolean
  graph: boolean
  chats: boolean
  unread: boolean
  push: boolean
  updated: boolean
}

// Chat-list ordering. 'recent' keeps the server order (chats arrive sorted by
// last-message time, newest first); 'alphabetical' sorts by display label.
export type ChatListSort = 'recent' | 'alphabetical'

// How the HeaderBar renders the active identity when the user segment is
// shown. 'full' → "Name (tenant)"; 'tenant' → just the tenant (or profile).
export type HeaderUserFormat = 'full' | 'tenant'

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

// Flat color tokens. At the top level of ThemeOverrides they apply to every
// base theme (legacy); under `dark` / `light` they apply only to that base,
// which is where the theme editor writes, so switching themes stays visible.
export type ThemeColorOverrides = {
  appBackground?: string | null
  modalBackground?: string | null
  text?: string | null
  mutedText?: string | null
  border?: string | null
  borderActive?: string | null
  selected?: string | null
  selectedRow?: string | null
  unread?: string | null
  unreadRow?: string | null
  timestamp?: string | null
  sender?: string | null
  selfMessage?: string | null
  selfName?: string | null
  selfMessageBackground?: string | null
  senderMessage?: string | null
  senderMessageBackground?: string | null
  selectedRowBorder?: string | null
  messageFocusBorder?: string | null
  selfMessageBorder?: string | null
  senderMessageBorder?: string | null
  chatListPreviewText?: string | null
  accountHeader?: string | null
  crossFavoritesHeader?: string | null
  systemEvent?: string | null
  dateMarker?: string | null
  errorText?: string | null
  warnText?: string | null
  infoText?: string | null
  messageFocusIndicator?: string | null
  messageFocusText?: string | null
  messageFocusBackground?: string | null
  selectedRowBackground?: string | null
}

export type ThemeOverrides = ThemeColorOverrides & {
  dark?: ThemeColorOverrides
  light?: ThemeColorOverrides
  presence?: Partial<Record<ThemePresenceKey, string>>
  layout?: Partial<{
    modalPaddingX: number
    modalPaddingY: number
    paneHeaderPaddingLeft: number
    senderIndent: number
    paneHeaderMarginBottom: number
    chatListIndent: number
    chatListGap: number
    accountGap: number
    textBackgroundPaddingX: number
    textBackgroundPaddingY: number
    dateMarkerIndent: number
    messageMaxWidth: number
    textBackgroundRadius: number
    avatarIndent: number
    senderPinned: number
    avatarPinned: number
  }>
  borders?: Partial<{
    panel: BorderStyleName
    modal: BorderStyleName
    active: BorderStyleName
    selectedRow: BorderStyleName
    focusedMessage: BorderStyleName
    selfMessage: BorderStyleName
    senderMessage: BorderStyleName
  }>
  emphasis?: Partial<{
    modalTitleBold: boolean
    sectionHeadingBold: boolean
    accountHeaderBold: boolean
    crossFavoritesHeaderBold: boolean
    selectedBold: boolean
    focusedBold: boolean
    dateMarkerBold: boolean
    unreadBold: boolean
    senderBold: boolean
    inlineKeyBold: boolean
  }>
  // Percent of the base font size (50-100) per text type. Rendered through
  // the kitty text sizing protocol; ignored on terminals without it.
  // tightSpacing packs shrunk one-line text to the scaled letter pitch.
  fontSize?: Partial<Record<ThemeFontSizeKey, number> & { tightSpacing: boolean }>
}

export const THEME_FONT_SIZE_KEYS = [
  'timestamp',
  'sender',
  'messageText',
  'paneHeader',
  'chatListHeader',
  'chatListName',
  'chatListPreview',
  'dateMarker',
] as const
export type ThemeFontSizeKey = (typeof THEME_FONT_SIZE_KEYS)[number]

export type Settings = {
  theme: ThemeMode
  themeOverrides: ThemeOverrides
  accounts: string[]
  activeAccount: string | null
  // Aliases in `accounts` turned off in the Accounts modal (Space): kept in
  // the list with their routing, favorites and caches, but not started.
  disabledAccounts: string[]
  // Order chats appear in the sidebar. 'recent' (default) preserves the
  // server's last-message ordering; 'alphabetical' sorts by display label.
  chatListSort: ChatListSort
  // When true, chats are grouped into Direct / Groups / Meetings sections
  // (each with a non-selectable header) instead of one flat list. Ordering
  // within each section still follows chatListSort. Default false.
  chatListGroupByType: boolean
  // When grouped, show at most CHAT_SECTION_CAP chats per section behind a
  // `… N more` row. false lists every chat. Default true.
  chatListSectionCap: boolean
  // Collapsed sidebar headers, keyed by chat-section name ('oneOnOne',
  // 'group', 'meeting', 'other') or `team:<id>`. A collapsed header hides
  // its children and becomes the cursor stop that restores them.
  chatListCollapsedSections: Record<string, boolean>
  // When true, sidebar chat rows render the first name only ("Ola",
  // "Anna, Bjorn, +1") instead of the full corporate-AD form
  // ("Nordmann, Ola Berg"). The MessagePane header always uses the
  // full form regardless. Default false (full names) so disambiguation
  // is preserved out of the box; users with mostly-internal contacts
  // can flip this on.
  chatListShortNames: boolean
  // Lines of last-message preview under each sidebar chat row, 0 (off) to 3.
  // Shorter previews take fewer lines. Light gray for read chats, the unread
  // color for unread ones. Default 1.
  chatListPreviewLines: number
  // When true (default), the message pane renders the sender column as
  // first-name only ("Ola") instead of the full display name
  // ("Nordmann, Ola Berg"). Independent of `chatListShortNames` so
  // users can short-name one place and not the other.
  messagePaneShortNames: boolean
  // Show the open conversation's name (1:1 partner, group chat name, or
  // team · # channel) above the messages. Default false.
  showChatNameHeader: boolean
  showPresenceInList: boolean
  // Sidebar Favorites section. Off lists favorited items in their normal
  // sections; the stored favorites are kept.
  showFavorites: boolean
  // Favorited sidebar items per account, keyed by profile alias ('' for the
  // owa-piggy default profile). Each id is `chat:<chatId>` or
  // `channel:<teamId>/<channelId>`. Local only: never written to Teams.
  favoritesByAccount: Record<string, string[]>
  // Cross-account favorites (Ctrl+F), same keys and ids: one Favorites block
  // above every account in the unified sidebar. An item in both lists shows
  // here only.
  crossAccountFavorites: Record<string, string[]>
  // 'transient': only on a message sent a while after the previous one
  // (TRANSIENT_TIMESTAMP_GAP_MS in MessagePane).
  showTimestampsInPane: 'off' | 'on' | 'transient'
  // Day separators ("Today") centered in the message pane.
  centerDateMarkers: boolean
  // Profile pictures beside other people's messages / thumbnails in the
  // chat list (kitty graphics terminals only). Size = rows tall.
  messageAvatars: 'off' | 'small' | 'medium' | 'large'
  chatListThumbnails: 'off' | 'small' | 'medium' | 'large'
  // Where chat-list presence shows with thumbnails on: a dot beside the
  // name, a dot on the picture's corner (badge), or a strip down its side.
  chatListPresenceStyle: 'dot' | 'badge' | 'bar'
  // Sender name above message bodies; showOwnNameInPane covers your own.
  showSenderNamesInPane: boolean
  showOwnNameInPane: boolean
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
  // Run every profile in `accounts` at once instead of switching between
  // them (default on; false opts into single mode). Read at startup;
  // --profile forces single mode.
  concurrentAccounts: boolean
  // Notification preferences. notifyMuted is a session-level kill switch
  // that suppresses banners (bell still rings — terminal-level mute is
  // the user's responsibility). notifyActiveBanner forces the banner
  // even when the user is already viewing the active conv (default off:
  // bell only). notifyChatMessages extends banners from @mentions to
  // every new 1:1 / group chat message, like the Teams client.
  // quietHoursStart/End are HH:MM strings or null to disable.
  notifyMuted: boolean
  notifyChatMessages: boolean
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
  // Jump the message cursor (and so the scroll) to a newly arrived message
  // in the open conversation.
  scrollOnNewMessages: boolean
  // Composer: Enter sends and Shift/Ctrl+Enter is a newline (flipped default).
  enterSends: boolean
  // Mouse: click a sidebar row, wheel through the list and messages. Off by
  // default: reporting takes over the terminal's own text selection.
  mouse: boolean
  // Inline image rendering for message attachments.
  // 'auto': show images via Kitty graphics protocol when the terminal
  //   supports it (KITTY_WINDOW_ID / TERM=xterm-kitty); fall back to
  //   compact text row otherwise.
  // 'off': always show the text fallback, even in Kitty terminals.
  inlineImages: 'auto' | 'off'
  // Maximum terminal rows a single inline image may occupy. Images taller
  // than this are scaled down by the terminal to fit. Default 10.
  inlineImageMaxRows: number
  // Where the status bar renders.
  //   'bottom' (default) - below the composer; current behavior.
  //   'hidden' - suppress the status bar entirely, gaining one row of
  //              vertical space in the message pane. The terminal title
  //              and the diagnostics modal remain available for the
  //              information the status bar would have shown.
  // 'top' renders the same bar as the first row of the layout instead.
  statusBarPosition: 'bottom' | 'top' | 'hidden'
  // Which optional HeaderBar segments are shown — including the leading app
  // name. Anything can be hidden to trim the top row. All default true.
  headerElements: HeaderElementVisibility
  // How the HeaderBar renders the active identity when headerElements.user is
  // shown. 'full' (default) → "Name (tenant)"; 'tenant' → just the tenant.
  headerUserFormat: HeaderUserFormat
  // When false, the status bar drops its keyboard-shortcut hints and is used
  // only to surface the focused link/image context action. Default true.
  statusBarShowKeyHints: boolean
  // Center the HeaderBar segments. Off pins them left. Default false.
  headerBarCentered: boolean
  // Per-account chat routing mode, keyed by profile/account name. Controls
  // both which owa-piggy token audience is minted for default Graph calls
  // and whether chat message reads/sends use graph.microsoft.com or the
  // Teams chatsvc (ic3) endpoints — plus whether a failure falls back to the
  // other transport:
  //   'graph+ic3' (default) — graph first, fall back to chatsvc on 401
  //   'ic3+graph'           — chatsvc first, fall back to graph on failure
  //   'ic3-only'            — chatsvc only, never touch graph chat endpoints
  //   'graph-only'          — graph only, never fall back to chatsvc
  // Accounts gated by Conditional Access on graph.microsoft.com should use
  // 'ic3-only' to avoid hammering the same 401-returning endpoints. Toggled
  // per account in the esc-menu Accounts list. Absent => graph+ic3.
  chatRoutingByAccount: Record<string, ChatRoutingMode>
  // Explicit chat-list panel width in terminal columns. null means automatic
  // (derived from terminal width via computeLayout). Adjusted interactively
  // via Ctrl-X resize mode; persisted to config.json.
  chatListWidth: number | null
  // Explicit composer height in terminal rows. null means automatic (derived
  // from draft line count via computeLayout). Adjusted interactively via
  // Ctrl-X resize mode; persisted to config.json.
  composerHeight: number | null
}

export type TokenAudience = 'graph' | 'ic3'

export const DEFAULT_TOKEN_AUDIENCE: TokenAudience = 'graph'

export type ChatRoutingMode = 'graph+ic3' | 'ic3+graph' | 'ic3-only' | 'graph-only'

export const DEFAULT_CHAT_ROUTING: ChatRoutingMode = 'graph+ic3'

// The order the Accounts-list 't' key cycles through.
export const CHAT_ROUTING_MODES: readonly ChatRoutingMode[] = [
  'graph+ic3',
  'ic3+graph',
  'ic3-only',
  'graph-only',
]

// Resolve the routing mode for an account, defaulting to graph+ic3 when the
// account has no explicit preference.
export function routingForAccount(
  settings: Pick<Settings, 'chatRoutingByAccount'>,
  account: string | null | undefined,
): ChatRoutingMode {
  if (!account) return DEFAULT_CHAT_ROUTING
  return settings.chatRoutingByAccount[account] ?? DEFAULT_CHAT_ROUTING
}

// The aliases in `accounts` that are not turned off, in configured order.
export function enabledAccounts(
  settings: Pick<Settings, 'accounts' | 'disabledAccounts'>,
): string[] {
  return settings.accounts.filter((p) => !settings.disabledAccounts.includes(p))
}

// Next mode in the cycle, for the Accounts-list toggle.
export function nextChatRouting(mode: ChatRoutingMode): ChatRoutingMode {
  const i = CHAT_ROUTING_MODES.indexOf(mode)
  return CHAT_ROUTING_MODES[(i + 1) % CHAT_ROUTING_MODES.length]!
}

// Resolve a routing mode into the token audience to mint and whether the
// graph client / chat transport may fall back to the other transport.
export function audienceFromRouting(mode: ChatRoutingMode): {
  audience: TokenAudience
  fallback: boolean
} {
  switch (mode) {
    case 'graph+ic3':
      return { audience: 'graph', fallback: true }
    case 'graph-only':
      return { audience: 'graph', fallback: false }
    case 'ic3+graph':
      return { audience: 'ic3', fallback: true }
    case 'ic3-only':
      return { audience: 'ic3', fallback: false }
  }
}

export const defaultSettings: Settings = {
  theme: 'auto',
  themeOverrides: {},
  accounts: [],
  activeAccount: null,
  disabledAccounts: [],
  chatListSort: 'recent',
  chatListGroupByType: false,
  chatListSectionCap: true,
  chatListCollapsedSections: {},
  chatListShortNames: false,
  chatListPreviewLines: 1,
  messagePaneShortNames: true,
  showChatNameHeader: false,
  showPresenceInList: true,
  showFavorites: true,
  favoritesByAccount: {},
  crossAccountFavorites: {},
  showTimestampsInPane: 'on',
  centerDateMarkers: false,
  messageAvatars: 'off',
  chatListThumbnails: 'off',
  chatListPresenceStyle: 'dot',
  showSenderNamesInPane: true,
  showOwnNameInPane: true,
  showReactions: 'current',
  messageFocusIndicatorEnabled: true,
  messageFocusIndicatorChar: '>',
  messageFocusIndicatorColor: null,
  messageFocusBackgroundColor: null,
  useTeamsPresence: true,
  forceAvailableWhenFocused: true,
  realtimeEnabled: false,
  concurrentAccounts: true,
  notifyMuted: false,
  notifyChatMessages: true,
  notifyActiveBanner: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  logFile: null,
  tailEvents: false,
  tailNetwork: false,
  tailDiagnostics: false,
  selfMessagesOnRight: false,
  scrollOnNewMessages: true,
  enterSends: false,
  mouse: false,
  inlineImages: 'auto',
  inlineImageMaxRows: 10,
  statusBarPosition: 'bottom',
  headerElements: {
    app: true,
    user: true,
    presence: true,
    graph: true,
    chats: true,
    unread: true,
    push: true,
    updated: true,
  },
  headerUserFormat: 'full',
  statusBarShowKeyHints: true,
  headerBarCentered: false,
  chatRoutingByAccount: {},
  chatListWidth: null,
  composerHeight: null,
}
