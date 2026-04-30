// Layered color and style resolver. Ink color strings are passed through to
// chalk, so config validation accepts common named colors plus hex strings.

import type { Settings, ThemeMode, ThemeOverrides, ThemePresenceKey } from '../state/store'

export type PresenceMap = Record<ThemePresenceKey, string>

export type Theme = {
  background: string
  text: string
  mutedText: string
  border: string
  borderActive: string
  selected: string
  selectedRow: string
  unread: string
  unreadRow: string
  timestamp: string
  sender: string
  selfMessage: string
  systemEvent: string
  errorText: string
  warnText: string
  infoText: string
  messageFocusIndicator: string
  messageFocusBackground: string | null
  presence: PresenceMap
}

export const builtinThemes: Record<ThemeMode, Theme> = {
  dark: {
    background: 'black',
    text: 'white',
    mutedText: 'gray',
    border: 'gray',
    borderActive: 'cyan',
    selected: 'cyan',
    selectedRow: 'cyan',
    unread: 'yellow',
    unreadRow: 'yellow',
    timestamp: 'gray',
    sender: 'white',
    selfMessage: 'blue',
    systemEvent: 'gray',
    errorText: 'red',
    warnText: 'yellow',
    infoText: 'gray',
    messageFocusIndicator: 'cyan',
    messageFocusBackground: null,
    presence: {
      Available: 'green',
      AvailableIdle: 'green',
      Away: 'yellow',
      BeRightBack: 'yellow',
      Busy: 'red',
      BusyIdle: 'red',
      DoNotDisturb: 'red',
      Offline: 'gray',
      OutOfOffice: 'magenta',
      PresenceUnknown: 'gray',
    },
  },
  light: {
    background: 'white',
    text: 'black',
    mutedText: 'gray',
    border: 'gray',
    borderActive: 'blue',
    selected: 'blue',
    selectedRow: 'blue',
    unread: 'magenta',
    unreadRow: 'magenta',
    timestamp: 'gray',
    sender: 'black',
    selfMessage: 'blue',
    systemEvent: 'gray',
    errorText: 'red',
    warnText: 'yellow',
    infoText: 'black',
    messageFocusIndicator: 'blue',
    messageFocusBackground: null,
    presence: {
      Available: 'green',
      AvailableIdle: 'green',
      Away: 'yellow',
      BeRightBack: 'yellow',
      Busy: 'red',
      BusyIdle: 'red',
      DoNotDisturb: 'red',
      Offline: 'gray',
      OutOfOffice: 'magenta',
      PresenceUnknown: 'gray',
    },
  },
}

export function getTheme(mode: ThemeMode): Theme {
  return cloneTheme(builtinThemes[mode])
}

export function resolveTheme(settings: Settings): Theme {
  const base = cloneTheme(builtinThemes[settings.theme])
  const merged = applyOverrides(base, settings.themeOverrides)

  if (settings.messageFocusIndicatorColor) {
    merged.messageFocusIndicator = settings.messageFocusIndicatorColor
  }
  if (settings.messageFocusBackgroundColor !== null) {
    merged.messageFocusBackground = settings.messageFocusBackgroundColor
  }

  return merged
}

function applyOverrides(theme: Theme, overrides: ThemeOverrides): Theme {
  const { presence, ...flat } = overrides
  for (const [key, value] of Object.entries(flat) as [
    keyof Omit<ThemeOverrides, 'presence'>,
    string | null | undefined,
  ][]) {
    if (value !== undefined) {
      ;(theme[key] as string | null) = value
    }
  }
  if (presence) {
    theme.presence = { ...theme.presence, ...presence }
  }
  return theme
}

function cloneTheme(input: Theme): Theme {
  return {
    ...input,
    presence: { ...input.presence },
  }
}

// Legacy default export so any non-component code paths that still import
// `theme` directly keep working. New code should prefer useTheme().
export const theme = getTheme('dark')

export type PresenceColorKey = ThemePresenceKey
