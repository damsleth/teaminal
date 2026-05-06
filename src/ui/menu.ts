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
// Disabled items render dim and the cursor skips them. Use `disabled: true`
// for "coming soon" placeholders so the structure is visible without
// implying the feature works yet.

import { updateSettings } from '../config'
import type { AccountManagerModalState, AppState, Settings, Store } from '../state/store'

// Toggle-setting keys are the subset of Settings keys exposed via menu
// toggles. Restricting at the type level keeps the menu schema honest.
export type ToggleKey =
  | 'theme'
  | 'chatListDensity'
  | 'chatListShortNames'
  | 'showPresenceInList'
  | 'showTimestampsInPane'
  | 'showReactions'
  | 'windowHeight'
  | 'messageFocusIndicatorEnabled'
  | 'messageFocusIndicatorChar'
  | 'forceAvailableWhenFocused'
  | 'realtimeEnabled'
  | 'notifyMuted'
  | 'notifyActiveBanner'
  | 'tailEvents'
  | 'tailNetwork'
  | 'tailDiagnostics'

export type MenuAction =
  | { kind: 'resume' }
  | { kind: 'quit' }
  | { kind: 'show-accounts' }
  | { kind: 'submenu' }
  | { kind: 'noop' }
  | { kind: 'toggle-setting'; key: ToggleKey }
  | { kind: 'cycle-quiet-hours' }
  | { kind: 'show-keybinds' }
  | { kind: 'show-diagnostics' }
  | { kind: 'show-events' }
  | { kind: 'show-network' }

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

export function cycleQuietHoursPreset(current: { start: string | null; end: string | null }): {
  start: string | null
  end: string | null
} {
  const idx = QUIET_HOURS_PRESETS.findIndex(
    (p) => p.start === current.start && p.end === current.end,
  )
  const next = QUIET_HOURS_PRESETS[(idx === -1 ? 0 : idx + 1) % QUIET_HOURS_PRESETS.length]!
  return next
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
    children: [
      {
        id: 'theme',
        label: 'Theme',
        action: { kind: 'toggle-setting', key: 'theme' },
      },
      {
        id: 'chatListDensity',
        label: 'Chat list density',
        action: { kind: 'toggle-setting', key: 'chatListDensity' },
      },
      {
        id: 'chatListShortNames',
        label: 'Short names in chat list',
        action: { kind: 'toggle-setting', key: 'chatListShortNames' },
      },
      {
        id: 'showPresenceInList',
        label: 'Show presence in chat list',
        action: { kind: 'toggle-setting', key: 'showPresenceInList' },
      },
      {
        id: 'forceAvailableWhenFocused',
        label: 'Set Available while terminal focused',
        action: { kind: 'toggle-setting', key: 'forceAvailableWhenFocused' },
      },
      {
        id: 'realtimeEnabled',
        label: 'Real-time push',
        action: { kind: 'toggle-setting', key: 'realtimeEnabled' },
        hint: 'restart',
      },
      {
        id: 'showTimestampsInPane',
        label: 'Show timestamps in messages',
        action: { kind: 'toggle-setting', key: 'showTimestampsInPane' },
      },
      {
        id: 'showReactions',
        label: 'Show reactions',
        action: { kind: 'toggle-setting', key: 'showReactions' },
      },
      {
        id: 'notifyMuted',
        label: 'Mute notifications',
        action: { kind: 'toggle-setting', key: 'notifyMuted' },
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
      {
        id: 'windowHeight',
        label: 'Window height',
        action: { kind: 'toggle-setting', key: 'windowHeight' },
      },
      {
        id: 'messageFocusIndicatorEnabled',
        label: 'Focused message marker',
        action: { kind: 'toggle-setting', key: 'messageFocusIndicatorEnabled' },
      },
      {
        id: 'messageFocusIndicatorChar',
        label: 'Focused message marker char',
        action: { kind: 'toggle-setting', key: 'messageFocusIndicatorChar' },
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
    ],
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
  return level
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

// Preset cycle for the windowHeight setting. 0 = fill the terminal.
// Add bespoke heights here; they show up automatically in the menu cycle
// and the renderSettingValue formatter.
export const WINDOW_HEIGHT_PRESETS = [0, 20, 30, 40] as const
export const MESSAGE_FOCUS_MARKER_PRESETS = ['>', '|', '*', '-'] as const
export const REACTION_DISPLAY_PRESETS = ['current', 'all', 'off'] as const

function cycleWindowHeight(current: number): number {
  const idx = WINDOW_HEIGHT_PRESETS.indexOf(current as (typeof WINDOW_HEIGHT_PRESETS)[number])
  if (idx === -1) return WINDOW_HEIGHT_PRESETS[0]!
  return WINDOW_HEIGHT_PRESETS[(idx + 1) % WINDOW_HEIGHT_PRESETS.length]!
}

function cycleMessageFocusIndicatorChar(current: string): string {
  const idx = MESSAGE_FOCUS_MARKER_PRESETS.indexOf(
    current as (typeof MESSAGE_FOCUS_MARKER_PRESETS)[number],
  )
  if (idx === -1) return MESSAGE_FOCUS_MARKER_PRESETS[0]!
  return MESSAGE_FOCUS_MARKER_PRESETS[(idx + 1) % MESSAGE_FOCUS_MARKER_PRESETS.length]!
}

function cycleReactionDisplayMode(current: Settings['showReactions']): Settings['showReactions'] {
  const idx = REACTION_DISPLAY_PRESETS.indexOf(current)
  if (idx === -1) return REACTION_DISPLAY_PRESETS[0]!
  return REACTION_DISPLAY_PRESETS[(idx + 1) % REACTION_DISPLAY_PRESETS.length]!
}

// Cycle a setting to its next value. Two-valued enums flip; booleans
// negate. Add new keys here when the Settings type grows.
export function cycleSetting<K extends ToggleKey>(key: K, current: Settings[K]): Settings[K] {
  switch (key) {
    case 'theme':
      return (current === 'dark' ? 'light' : 'dark') as Settings[K]
    case 'chatListDensity':
      return (current === 'cozy' ? 'compact' : 'cozy') as Settings[K]
    case 'showReactions':
      return cycleReactionDisplayMode(current as Settings['showReactions']) as Settings[K]
    case 'chatListShortNames':
    case 'showPresenceInList':
    case 'showTimestampsInPane':
    case 'messageFocusIndicatorEnabled':
    case 'forceAvailableWhenFocused':
    case 'realtimeEnabled':
    case 'notifyMuted':
    case 'notifyActiveBanner':
    case 'tailEvents':
    case 'tailNetwork':
    case 'tailDiagnostics':
      return !current as Settings[K]
    case 'windowHeight':
      return cycleWindowHeight(current as number) as Settings[K]
    case 'messageFocusIndicatorChar':
      return cycleMessageFocusIndicatorChar(current as string) as Settings[K]
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
    case 'theme':
    case 'chatListDensity':
    case 'showReactions':
      return String(value)
    case 'chatListShortNames':
    case 'showPresenceInList':
    case 'showTimestampsInPane':
    case 'messageFocusIndicatorEnabled':
    case 'forceAvailableWhenFocused':
    case 'realtimeEnabled':
    case 'notifyMuted':
    case 'notifyActiveBanner':
    case 'tailEvents':
    case 'tailNetwork':
    case 'tailDiagnostics':
      return value ? 'on' : 'off'
    case 'windowHeight':
      return value === 0 ? 'full' : `${value} rows`
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
