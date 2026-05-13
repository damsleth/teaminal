import { describe, expect, test } from 'bun:test'
import {
  cycleQuietHoursPreset,
  cycleSetting,
  firstSelectable,
  nextSelectable,
  QUIET_HOURS_PRESETS,
  renderQuietHoursValue,
  renderSettingValue,
  resolveMenuPath,
  ROOT_MENU,
  type MenuItem,
  updateSetting,
} from './menu'
import { createAppStore } from '../state/store'

const enabled = (id: string, label = id): MenuItem => ({
  id,
  label,
  action: { kind: 'noop' },
})
const disabled = (id: string, label = id): MenuItem => ({
  id,
  label,
  action: { kind: 'noop' },
  disabled: true,
})

describe('resolveMenuPath', () => {
  test('returns root for empty path', () => {
    expect(resolveMenuPath(ROOT_MENU, [])).toBe(ROOT_MENU)
  })

  test('descends into a submenu', () => {
    const settings = ROOT_MENU.find((i) => i.id === 'settings')
    expect(resolveMenuPath(ROOT_MENU, ['settings'])).toBe(settings?.children!)
  })

  test('returns null for an unknown id', () => {
    expect(resolveMenuPath(ROOT_MENU, ['does-not-exist'])).toBeNull()
  })

  test('returns null when descending into a leaf', () => {
    expect(resolveMenuPath(ROOT_MENU, ['quit'])).toBeNull()
  })
})

describe('firstSelectable', () => {
  test('returns first index when first item is enabled', () => {
    expect(firstSelectable([enabled('a'), enabled('b')])).toBe(0)
  })

  test('skips disabled prefix', () => {
    expect(firstSelectable([disabled('a'), disabled('b'), enabled('c')])).toBe(2)
  })

  test('returns -1 when all disabled', () => {
    expect(firstSelectable([disabled('a'), disabled('b')])).toBe(-1)
  })

  test('returns -1 for empty list', () => {
    expect(firstSelectable([])).toBe(-1)
  })
})

describe('nextSelectable', () => {
  test('moves forward to next enabled item', () => {
    const items = [enabled('a'), enabled('b'), enabled('c')]
    expect(nextSelectable(items, 0, 1)).toBe(1)
  })

  test('wraps from last to first', () => {
    const items = [enabled('a'), enabled('b'), enabled('c')]
    expect(nextSelectable(items, 2, 1)).toBe(0)
  })

  test('skips disabled items walking forward', () => {
    const items = [enabled('a'), disabled('b'), enabled('c')]
    expect(nextSelectable(items, 0, 1)).toBe(2)
  })

  test('skips disabled items walking backward', () => {
    const items = [enabled('a'), disabled('b'), enabled('c')]
    expect(nextSelectable(items, 2, -1)).toBe(0)
  })

  test('returns -1 when all items are disabled', () => {
    expect(nextSelectable([disabled('a'), disabled('b')], 0, 1)).toBe(-1)
  })
})

describe('cycleSetting', () => {
  test('cycles theme through built-in presets', () => {
    expect(cycleSetting('theme', 'dark')).toBe('light')
    expect(cycleSetting('theme', 'light')).toBe('compact')
    expect(cycleSetting('theme', 'compact')).toBe('comfortable')
    expect(cycleSetting('theme', 'comfortable')).toBe('dark')
  })

  test('flips chat list density between cozy and compact', () => {
    expect(cycleSetting('chatListDensity', 'cozy')).toBe('compact')
    expect(cycleSetting('chatListDensity', 'compact')).toBe('cozy')
  })

  test('negates booleans', () => {
    expect(cycleSetting('showPresenceInList', true)).toBe(false)
    expect(cycleSetting('showPresenceInList', false)).toBe(true)
    expect(cycleSetting('showTimestampsInPane', true)).toBe(false)
    expect(cycleSetting('messageFocusIndicatorEnabled', true)).toBe(false)
    expect(cycleSetting('realtimeEnabled', false)).toBe(true)
  })

  test('cycles focused-message marker chars through presets', () => {
    expect(cycleSetting('messageFocusIndicatorChar', '>')).toBe('|')
    expect(cycleSetting('messageFocusIndicatorChar', '|')).toBe('*')
    expect(cycleSetting('messageFocusIndicatorChar', '*')).toBe('-')
    expect(cycleSetting('messageFocusIndicatorChar', '-')).toBe('>')
    expect(cycleSetting('messageFocusIndicatorChar', '!')).toBe('>')
  })

  test('cycles reaction display mode through presets', () => {
    expect(cycleSetting('showReactions', 'current')).toBe('all')
    expect(cycleSetting('showReactions', 'all')).toBe('off')
    expect(cycleSetting('showReactions', 'off')).toBe('current')
  })
})

describe('renderSettingValue', () => {
  test('renders enum values verbatim', () => {
    expect(renderSettingValue('theme', 'dark')).toBe('dark')
    expect(renderSettingValue('chatListDensity', 'compact')).toBe('compact')
    expect(renderSettingValue('showReactions', 'current')).toBe('current')
  })

  test('renders booleans as on/off', () => {
    expect(renderSettingValue('showPresenceInList', true)).toBe('on')
    expect(renderSettingValue('showPresenceInList', false)).toBe('off')
    expect(renderSettingValue('messageFocusIndicatorEnabled', false)).toBe('off')
    expect(renderSettingValue('realtimeEnabled', true)).toBe('on')
  })

  test('renders focused-message marker char', () => {
    expect(renderSettingValue('messageFocusIndicatorChar', '|')).toBe('|')
  })
})

describe('updateSetting', () => {
  test('updates the store and calls the persistence hook with a patch', async () => {
    const store = createAppStore()
    const patches: unknown[] = []

    await updateSetting(store, 'theme', 'light', async (patch) => {
      patches.push(patch)
      return store.get().settings
    })

    expect(store.get().settings.theme).toBe('light')
    expect(patches).toEqual([{ theme: 'light' }])
  })
})

describe('ROOT_MENU shape', () => {
  test('settings submenu exposes the full toggle set', () => {
    const settings = ROOT_MENU.find((i) => i.id === 'settings')
    const toggleKeys = (settings?.children ?? [])
      .map((c) => (c.action.kind === 'toggle-setting' ? c.action.key : null))
      .filter((k): k is NonNullable<typeof k> => k !== null)
    expect(toggleKeys).toEqual([
      'theme',
      'chatListDensity',
      'chatListShortNames',
      'messagePaneShortNames',
      'showPresenceInList',
      'forceAvailableWhenFocused',
      'realtimeEnabled',
      'showTimestampsInPane',
      'showReactions',
      'notifyMuted',
      'notifyActiveBanner',
      'messageFocusIndicatorEnabled',
      'messageFocusIndicatorChar',
      'tailEvents',
      'tailNetwork',
      'tailDiagnostics',
    ])
  })

  test('top-level account entry is renamed and scaffolded', () => {
    const accounts = ROOT_MENU.find((i) => i.id === 'accounts')
    expect(accounts?.label).toBe('Accounts')
    expect(accounts?.action.kind).toBe('show-accounts')
    expect(accounts?.disabled).toBeUndefined()
  })

  test('help submenu has a keybindings entry that triggers show-keybinds', () => {
    const help = ROOT_MENU.find((i) => i.id === 'help')
    const keybinds = help?.children?.find((c) => c.id === 'keybinds')
    expect(keybinds?.action.kind).toBe('show-keybinds')
  })

  test('settings submenu has a quiet-hours cycle entry', () => {
    const settings = ROOT_MENU.find((i) => i.id === 'settings')
    const quiet = settings?.children?.find((c) => c.id === 'quietHours')
    expect(quiet?.action.kind).toBe('cycle-quiet-hours')
  })

  test('realtime setting is marked restart-required', () => {
    const settings = ROOT_MENU.find((i) => i.id === 'settings')
    const realtime = settings?.children?.find((c) => c.id === 'realtimeEnabled')
    expect(realtime?.hint).toBe('restart')
  })
})

describe('cycleQuietHoursPreset', () => {
  test('cycles forward through preset list', () => {
    const a = cycleQuietHoursPreset({ start: null, end: null })
    expect(a).toEqual(QUIET_HOURS_PRESETS[1]!)
    const b = cycleQuietHoursPreset(a)
    expect(b).toEqual(QUIET_HOURS_PRESETS[2]!)
  })

  test('wraps from last preset back to off', () => {
    const last = QUIET_HOURS_PRESETS[QUIET_HOURS_PRESETS.length - 1]!
    expect(cycleQuietHoursPreset(last)).toEqual(QUIET_HOURS_PRESETS[0]!)
  })

  test('non-preset values jump to off then advance', () => {
    expect(cycleQuietHoursPreset({ start: '01:00', end: '02:00' })).toEqual(QUIET_HOURS_PRESETS[0]!)
  })
})

describe('renderQuietHoursValue', () => {
  test('renders "off" when either side is null', () => {
    expect(renderQuietHoursValue(null, null)).toBe('off')
    expect(renderQuietHoursValue('22:00', null)).toBe('off')
    expect(renderQuietHoursValue(null, '07:00')).toBe('off')
  })

  test('renders the window when both are set', () => {
    expect(renderQuietHoursValue('22:00', '07:00')).toBe('22:00 - 07:00')
  })
})
