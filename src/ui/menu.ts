// Menu schema for the modal "pause-menu" (Esc from list focus opens it).
//
// Tree of MenuItem nodes; branches carry `children`, leaves carry an
// action. ROOT_MENU is the top-level entry. Submenu navigation tracks a
// path of ids through the tree so adding deeper menus later is just a
// matter of declaring children.
//
// Adding a menu item:
//   1. Append a MenuItem to ROOT_MENU (or to a `children` array)
//   2. Add the action variant to MenuAction if it's new
//   3. Handle the new action in MenuModal.activate (and add a value
//      formatter in valueForToggle below if it's a new toggle key)
//
// Invariant: every Settings key surfaced through the Menu modal must
// also appear in src/config/index.ts settingsToConfig + validateAndAssign.
// If you add a row here, update both ends and the test in
// src/config/index.test.ts (settingsToConfig coverage test).
//
// Disabled items render dim and the cursor skips them. Use `disabled: true`
// for "coming soon" placeholders so the structure is visible without
// implying the feature works yet.

import { updateSettings } from '../config'
import { kittyKeyboardEnabled } from './kittyKeyboard'
import { isKittyCapable } from './kittyGraphics'
import type {
  AccountManagerModalState,
  AppState,
  HeaderElementVisibility,
  Settings,
  Store,
} from '../state/store'

// Toggle-setting keys are the subset of Settings keys exposed via menu
// toggles. Restricting at the type level keeps the menu schema honest.
export type ToggleKey =
  | 'theme'
  | 'chatListSort'
  | 'chatListGroupByType'
  | 'chatListSectionCap'
  | 'headerUserFormat'
  | 'chatListShortNames'
  | 'chatListPreviewLines'
  | 'messagePaneShortNames'
  | 'showChatNameHeader'
  | 'showPresenceInList'
  | 'showTimestampsInPane'
  | 'centerDateMarkers'
  | 'messageAvatars'
  | 'chatListThumbnails'
  | 'chatListPresenceStyle'
  | 'showSenderNamesInPane'
  | 'showOwnNameInPane'
  | 'showReactions'
  | 'inlineImages'
  | 'messageFocusIndicatorEnabled'
  | 'messageFocusIndicatorChar'
  | 'scrollOnNewMessages'
  | 'enterSends'
  | 'selfMessagesOnRight'
  | 'forceAvailableWhenFocused'
  | 'useTeamsPresence'
  | 'realtimeEnabled'
  | 'notifyMuted'
  | 'notifyChatMessages'
  | 'notifyActiveBanner'
  | 'tailEvents'
  | 'tailNetwork'
  | 'tailDiagnostics'
  | 'statusBarPosition'
  | 'statusBarShowKeyHints'
  | 'headerBarCentered'

export type MenuAction =
  | { kind: 'resume' }
  | { kind: 'quit' }
  | { kind: 'show-accounts' }
  | { kind: 'show-notifications' }
  | { kind: 'submenu' }
  | { kind: 'noop' }
  | { kind: 'toggle-setting'; key: ToggleKey }
  | { kind: 'toggle-header-element'; key: keyof HeaderElementVisibility }
  | { kind: 'cycle-quiet-hours' }
  | { kind: 'show-theme-editor' }
  | { kind: 'show-theme-presets' }
  | { kind: 'show-keybinds' }
  | { kind: 'show-diagnostics' }
  | { kind: 'show-events' }
  | { kind: 'show-network' }
  | { kind: 'clear-cache' }

// Preset windows for the quiet-hours menu entry. The first preset (both
// null) is "off"; remaining presets cover the typical sleep windows.
// Adding a preset here makes it show up in the cycle automatically.
export const QUIET_HOURS_PRESETS: { start: string | null; end: string | null }[] = [
  { start: null, end: null },
  { start: '22:00', end: '07:00' },
  { start: '23:00', end: '06:00' },
  { start: '21:00', end: '08:00' },
  { start: '20:00', end: '09:00' },
]

export function cycleQuietHoursPreset(
  current: { start: string | null; end: string | null },
  dir: 1 | -1 = 1,
): { start: string | null; end: string | null } {
  const idx = QUIET_HOURS_PRESETS.findIndex(
    (p) => p.start === current.start && p.end === current.end,
  )
  if (idx === -1) return QUIET_HOURS_PRESETS[0]!
  const n = QUIET_HOURS_PRESETS.length
  return QUIET_HOURS_PRESETS[(idx + dir + n) % n]!
}

export function renderQuietHoursValue(start: string | null, end: string | null): string {
  if (!start || !end) return 'off'
  return `${start} - ${end}`
}

export type MenuItem = {
  id: string
  label: string
  action: MenuAction
  children?: MenuItem[]
  hint?: string
  disabled?: boolean
  // Left out of the menu when true (checked each time the level resolves).
  hidden?: () => boolean
}

// A non-selectable group label in a menu list.
function heading(label: string): MenuItem {
  return { id: `heading:${label}`, label: `── ${label}`, action: { kind: 'noop' }, disabled: true }
}

export const ROOT_MENU: MenuItem[] = [
  { id: 'resume', label: 'Resume', action: { kind: 'resume' } },
  {
    id: 'accounts',
    label: 'Accounts',
    action: { kind: 'show-accounts' },
  },
  {
    id: 'settings',
    label: 'Settings',
    action: { kind: 'submenu' },
    // Flat list in labeled groups (non-selectable heading rows), so it scans
    // top-to-bottom without submenus.
    children: [
      heading('Appearance'),
      {
        id: 'theme',
        label: 'Theme',
        action: { kind: 'toggle-setting', key: 'theme' },
      },
      {
        id: 'themeEditor',
        label: 'Theme editor',
        action: { kind: 'show-theme-editor' },
        hint: 'colors, spacing, borders',
      },
      {
        id: 'themePresets',
        label: 'Theme presets',
        action: { kind: 'show-theme-presets' },
        hint: 'load, save, save as, delete',
      },
      heading('Header & status bar'),
      {
        id: 'statusBarPosition',
        label: 'Status bar',
        action: { kind: 'toggle-setting', key: 'statusBarPosition' },
      },
      {
        id: 'statusBarShowKeyHints',
        label: 'Key hints',
        action: { kind: 'toggle-setting', key: 'statusBarShowKeyHints' },
        hint: 'off = link/image actions only',
      },
      {
        id: 'headerBarCentered',
        label: 'Center header bar',
        action: { kind: 'toggle-setting', key: 'headerBarCentered' },
      },
      {
        id: 'headerBar',
        label: 'Header elements',
        action: { kind: 'submenu' },
        children: [
          {
            id: 'header-app',
            label: 'App name',
            action: { kind: 'toggle-header-element', key: 'app' },
          },
          {
            id: 'header-user',
            label: 'User / tenant',
            action: { kind: 'toggle-header-element', key: 'user' },
          },
          {
            id: 'header-user-format',
            label: 'User shows',
            action: { kind: 'toggle-setting', key: 'headerUserFormat' },
          },
          {
            id: 'header-presence',
            label: 'Presence',
            action: { kind: 'toggle-header-element', key: 'presence' },
          },
          {
            id: 'header-graph',
            label: 'Graph status',
            action: { kind: 'toggle-header-element', key: 'graph' },
          },
          {
            id: 'header-chats',
            label: 'Chat count',
            action: { kind: 'toggle-header-element', key: 'chats' },
          },
          {
            id: 'header-unread',
            label: 'Unread / mentions',
            action: { kind: 'toggle-header-element', key: 'unread' },
          },
          {
            id: 'header-push',
            label: 'Push status',
            action: { kind: 'toggle-header-element', key: 'push' },
          },
          {
            id: 'header-updated',
            label: 'Updated time',
            action: { kind: 'toggle-header-element', key: 'updated' },
          },
        ],
      },
      heading('Chat list'),
      {
        id: 'chatListSort',
        label: 'Sort',
        action: { kind: 'toggle-setting', key: 'chatListSort' },
      },
      {
        id: 'chatListGroupByType',
        label: 'Group by type',
        action: { kind: 'toggle-setting', key: 'chatListGroupByType' },
        hint: '1:1 / group / meeting',
      },
      {
        id: 'chatListSectionCap',
        label: 'Cap groups at 10',
        action: { kind: 'toggle-setting', key: 'chatListSectionCap' },
        hint: 'off shows every chat',
      },
      {
        id: 'chatListShortNames',
        label: 'Short names',
        action: { kind: 'toggle-setting', key: 'chatListShortNames' },
      },
      {
        id: 'chatListPreviewLines',
        label: 'Preview lines',
        action: { kind: 'toggle-setting', key: 'chatListPreviewLines' },
        hint: 'off, 1, 2 or 3',
      },
      {
        id: 'showPresenceInList',
        label: 'Presence dots',
        action: { kind: 'toggle-setting', key: 'showPresenceInList' },
      },
      {
        id: 'chatListThumbnails',
        label: 'Thumbnails',
        action: { kind: 'toggle-setting', key: 'chatListThumbnails' },
        hint: 'photos and team pictures',
        // Pictures need the kitty graphics protocol.
        hidden: () => !isKittyCapable(),
      },
      {
        id: 'chatListPresenceStyle',
        label: 'Presence on thumbnails',
        action: { kind: 'toggle-setting', key: 'chatListPresenceStyle' },
        hint: 'dot by the name, badge on the picture, or a bar down its side',
        hidden: () => !isKittyCapable(),
      },
      heading('Messages'),
      {
        id: 'showChatNameHeader',
        label: 'Chat name header',
        action: { kind: 'toggle-setting', key: 'showChatNameHeader' },
        hint: 'person, group or channel name',
      },
      {
        id: 'messagePaneShortNames',
        label: 'Short names',
        action: { kind: 'toggle-setting', key: 'messagePaneShortNames' },
      },
      {
        id: 'showSenderNamesInPane',
        label: 'Sender names',
        action: { kind: 'toggle-setting', key: 'showSenderNamesInPane' },
      },
      {
        id: 'showOwnNameInPane',
        label: 'My name on my messages',
        action: { kind: 'toggle-setting', key: 'showOwnNameInPane' },
      },
      {
        id: 'selfMessagesOnRight',
        label: 'Right-align my messages',
        action: { kind: 'toggle-setting', key: 'selfMessagesOnRight' },
      },
      {
        id: 'showTimestampsInPane',
        label: 'Timestamps',
        action: { kind: 'toggle-setting', key: 'showTimestampsInPane' },
        hint: 'transient = after a 15 min pause',
      },
      {
        id: 'centerDateMarkers',
        label: 'Center dates',
        action: { kind: 'toggle-setting', key: 'centerDateMarkers' },
      },
      {
        id: 'showReactions',
        label: 'Reactions',
        action: { kind: 'toggle-setting', key: 'showReactions' },
      },
      {
        id: 'inlineImages',
        label: 'Images',
        action: { kind: 'toggle-setting', key: 'inlineImages' },
      },
      {
        id: 'messageAvatars',
        label: 'Profile pictures',
        action: { kind: 'toggle-setting', key: 'messageAvatars' },
        hidden: () => !isKittyCapable(),
      },
      heading('Navigation & input'),
      {
        id: 'messageFocusIndicatorEnabled',
        label: 'Focus marker',
        action: { kind: 'toggle-setting', key: 'messageFocusIndicatorEnabled' },
      },
      {
        id: 'messageFocusIndicatorChar',
        label: 'Focus marker char',
        action: { kind: 'toggle-setting', key: 'messageFocusIndicatorChar' },
      },
      {
        id: 'scrollOnNewMessages',
        label: 'Scroll on new messages',
        action: { kind: 'toggle-setting', key: 'scrollOnNewMessages' },
      },
      {
        id: 'enterSends',
        label: 'Enter sends (Shift/Ctrl+Enter newline)',
        action: { kind: 'toggle-setting', key: 'enterSends' },
        // Without the kitty keyboard protocol Shift+Enter reads as Enter,
        // so this mode would send half-written messages.
        hidden: () => !kittyKeyboardEnabled(),
      },
      heading('Notifications'),
      {
        id: 'notifyMuted',
        label: 'Mute',
        action: { kind: 'toggle-setting', key: 'notifyMuted' },
      },
      {
        id: 'notifyChatMessages',
        label: 'Every chat message',
        action: { kind: 'toggle-setting', key: 'notifyChatMessages' },
        hint: 'off = @mentions only',
      },
      {
        id: 'notifyActiveBanner',
        label: 'Banner for active conversation',
        action: { kind: 'toggle-setting', key: 'notifyActiveBanner' },
      },
      {
        id: 'quietHours',
        label: 'Quiet hours',
        action: { kind: 'cycle-quiet-hours' },
      },
      heading('Presence'),
      {
        id: 'forceAvailableWhenFocused',
        label: 'Available while terminal focused',
        action: { kind: 'toggle-setting', key: 'forceAvailableWhenFocused' },
      },
      {
        id: 'useTeamsPresence',
        label: 'Teams presence source',
        action: { kind: 'toggle-setting', key: 'useTeamsPresence' },
      },
      heading('Advanced'),
      {
        id: 'realtimeEnabled',
        label: 'Real-time push',
        action: { kind: 'toggle-setting', key: 'realtimeEnabled' },
        hint: 'restart',
      },
      {
        id: 'tailEvents',
        label: 'Tail event log',
        action: { kind: 'toggle-setting', key: 'tailEvents' },
      },
      {
        id: 'tailNetwork',
        label: 'Tail network',
        action: { kind: 'toggle-setting', key: 'tailNetwork' },
      },
      {
        id: 'tailDiagnostics',
        label: 'Tail diagnostics',
        action: { kind: 'toggle-setting', key: 'tailDiagnostics' },
      },
      {
        id: 'clearCache',
        label: 'Empty cache (this profile)',
        action: { kind: 'clear-cache' },
        hint: 'messages, list, images',
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    action: { kind: 'show-notifications' },
    hint: 'Ctrl+A',
  },
  {
    id: 'help',
    label: 'Help',
    action: { kind: 'submenu' },
    children: [
      {
        id: 'keybinds',
        label: 'Keybindings',
        action: { kind: 'show-keybinds' },
      },
      {
        id: 'diagnostics',
        label: 'Diagnostics',
        action: { kind: 'show-diagnostics' },
      },
      {
        id: 'events',
        label: 'Event log',
        action: { kind: 'show-events' },
      },
      {
        id: 'network',
        label: 'Network',
        action: { kind: 'show-network' },
      },
    ],
  },
  { id: 'quit', label: 'Quit', action: { kind: 'quit' } },
]

// Walk the menu tree by id-path. resolveMenuPath(ROOT_MENU, []) returns the
// root list; resolveMenuPath(ROOT_MENU, ['settings']) returns Settings'
// children. Null when a segment is missing or not a branch.
export function resolveMenuPath(root: MenuItem[], path: string[]): MenuItem[] | null {
  let level = root
  for (const id of path) {
    const node = level.find((m) => m.id === id)
    if (!node || !node.children) return null
    level = node.children
  }
  return level.filter((m) => !m.hidden?.())
}

// Slice of items to show so a long submenu (e.g. Settings) doesn't overflow
// the centered MenuModal overlay and clip rows off-screen. The window follows
// the cursor, keeping it roughly centered, clamped to the list ends.
export function menuItemWindow(
  count: number,
  cursor: number,
  maxVisible: number,
): { start: number; end: number } {
  if (maxVisible >= count) return { start: 0, end: count }
  let start = cursor - Math.floor(maxVisible / 2)
  start = Math.max(0, Math.min(start, count - maxVisible))
  return { start, end: start + maxVisible }
}

// First selectable index in items, -1 if all disabled.
export function firstSelectable(items: MenuItem[]): number {
  for (let i = 0; i < items.length; i++) {
    if (!items[i]!.disabled) return i
  }
  return -1
}

// Next selectable index from `from` walking by `dir` (+1 or -1). Wraps
// around. Returns -1 if no item is selectable. The "next" item is the
// first selectable strictly after `from` in the walk direction.
export function nextSelectable(items: MenuItem[], from: number, dir: 1 | -1): number {
  if (items.length === 0) return -1
  let i = from
  for (let n = 0; n < items.length; n++) {
    i = (i + dir + items.length) % items.length
    if (!items[i]!.disabled) return i
  }
  return -1
}

// The selectable item about `delta` rows from `from`, clamped to the list
// (no wrap): page keys stop at the ends. Lands on the nearest selectable
// row in the direction of travel, else the nearest one back.
export function pageSelectable(items: MenuItem[], from: number, delta: number): number {
  if (items.length === 0) return -1
  const target = Math.max(0, Math.min(items.length - 1, from + delta))
  const dir = delta >= 0 ? 1 : -1
  for (let i = target; i >= 0 && i < items.length; i += dir) if (!items[i]!.disabled) return i
  for (let i = target; i >= 0 && i < items.length; i -= dir) if (!items[i]!.disabled) return i
  return from
}

export const MESSAGE_FOCUS_MARKER_PRESETS = ['>', '|', '*', '-'] as const
export const REACTION_DISPLAY_PRESETS = ['current', 'all', 'off'] as const

// The value `dir` steps away from `current` in `order`, wrapping. An unknown
// current value lands on the first entry.
export function stepIn<T>(order: readonly T[], current: T, dir: 1 | -1 = 1): T {
  const idx = order.indexOf(current)
  if (idx === -1) return order[0]!
  return order[(idx + dir + order.length) % order.length]!
}

// Cycle a setting to its next (dir 1) or previous (dir -1) value; booleans
// negate. Add new keys here when the Settings type grows. `theme` cycles
// the built-ins only; the menu adds saved presets (see themeChoices).
export function cycleSetting<K extends ToggleKey>(
  key: K,
  current: Settings[K],
  dir: 1 | -1 = 1,
): Settings[K] {
  const step = (order: readonly unknown[]) => stepIn(order, current, dir) as Settings[K]
  switch (key) {
    case 'theme':
      return step(['auto', 'dark', 'light'])
    case 'chatListSort':
      return step(['recent', 'alphabetical'])
    case 'headerUserFormat':
      return step(['full', 'tenant'])
    case 'statusBarPosition':
      return step(['bottom', 'top', 'hidden'])
    case 'inlineImages':
      return step(['auto', 'off'])
    case 'showReactions':
      return step(REACTION_DISPLAY_PRESETS)
    case 'showTimestampsInPane':
      return step(['on', 'transient', 'off'])
    case 'messageAvatars':
    case 'chatListThumbnails':
      return step(['off', 'small', 'medium', 'large'])
    case 'chatListPreviewLines':
      return step([0, 1, 2, 3])
    case 'chatListPresenceStyle':
      return step(['dot', 'badge', 'bar'])
    case 'chatListGroupByType':
    case 'chatListSectionCap':
    case 'chatListShortNames':
    case 'messagePaneShortNames':
    case 'showChatNameHeader':
    case 'showPresenceInList':
    case 'centerDateMarkers':
    case 'showSenderNamesInPane':
    case 'showOwnNameInPane':
    case 'messageFocusIndicatorEnabled':
    case 'selfMessagesOnRight':
    case 'scrollOnNewMessages':
    case 'enterSends':
    case 'forceAvailableWhenFocused':
    case 'useTeamsPresence':
    case 'realtimeEnabled':
    case 'notifyMuted':
    case 'notifyChatMessages':
    case 'notifyActiveBanner':
    case 'tailEvents':
    case 'tailNetwork':
    case 'tailDiagnostics':
    case 'statusBarShowKeyHints':
    case 'headerBarCentered':
      return !current as Settings[K]
    case 'messageFocusIndicatorChar':
      return step(MESSAGE_FOCUS_MARKER_PRESETS)
  }
}

export async function updateSetting<K extends ToggleKey>(
  store: Store<AppState>,
  key: K,
  value: Settings[K],
  persist: (patch: Partial<Settings>) => Promise<Settings> = updateSettings,
): Promise<Settings> {
  let nextSettings: Settings | null = null
  store.set((s) => {
    nextSettings = { ...s.settings, [key]: value }
    return { settings: nextSettings }
  })
  await persist({ [key]: value } as Partial<Settings>)
  return nextSettings ?? store.get().settings
}

// Human-readable rendering of a setting's current value, used as the
// suffix on toggle-setting menu rows.
export function renderSettingValue<K extends ToggleKey>(key: K, value: Settings[K]): string {
  switch (key) {
    case 'inlineImages':
      // The stored 'auto'/'off' values read more clearly as how images
      // appear in the pane: drawn inline, or as openable text placeholders.
      return value === 'auto' ? 'inline' : 'as links'
    case 'theme':
    case 'chatListSort':
    case 'showReactions':
    case 'statusBarPosition':
    case 'showTimestampsInPane':
    case 'messageAvatars':
    case 'chatListThumbnails':
    case 'chatListPresenceStyle':
      return String(value)
    case 'headerUserFormat':
      return value === 'tenant' ? 'tenant only' : 'name + tenant'
    case 'chatListPreviewLines':
      return value === 0 ? 'off' : String(value)
    case 'chatListGroupByType':
    case 'chatListSectionCap':
    case 'chatListShortNames':
    case 'messagePaneShortNames':
    case 'showChatNameHeader':
    case 'showPresenceInList':
    case 'centerDateMarkers':
    case 'showSenderNamesInPane':
    case 'showOwnNameInPane':
    case 'messageFocusIndicatorEnabled':
    case 'selfMessagesOnRight':
    case 'scrollOnNewMessages':
    case 'enterSends':
    case 'forceAvailableWhenFocused':
    case 'useTeamsPresence':
    case 'realtimeEnabled':
    case 'notifyMuted':
    case 'notifyChatMessages':
    case 'notifyActiveBanner':
    case 'tailEvents':
    case 'tailNetwork':
    case 'tailDiagnostics':
    case 'statusBarShowKeyHints':
    case 'headerBarCentered':
      return value ? 'on' : 'off'
    case 'messageFocusIndicatorChar':
      return String(value)
  }
}

export function emptyAccountManagerModal(): AccountManagerModalState {
  return {
    kind: 'accounts',
    mode: 'list',
    cursor: 0,
    accounts: [],
  }
}
