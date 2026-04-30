// Color and style constants. Ink color names map to chalk; see
// https://github.com/chalk/chalk for the full palette.
//
// Two palettes are exported (dark, light); call getTheme(mode) to pick
// based on the user's settings. Components should read the active theme
// via the useTheme() hook so a settings change re-renders them with the
// new palette.

import type { ThemeMode } from '../state/store'

type PresenceMap = {
  Available: string
  AvailableIdle: string
  Away: string
  BeRightBack: string
  Busy: string
  BusyIdle: string
  DoNotDisturb: string
  Offline: string
  OutOfOffice: string
  PresenceUnknown: string
}

export type Theme = {
  border: string
  borderActive: string
  selected: string
  unread: string
  systemEvent: string
  selfMessage: string
  errorText: string
  warnText: string
  infoText: string
  presence: PresenceMap
}

const dark: Theme = {
  border: 'gray',
  borderActive: 'cyan',
  selected: 'cyan',
  unread: 'yellow',
  systemEvent: 'gray',
  selfMessage: 'blue',
  errorText: 'red',
  warnText: 'yellow',
  infoText: 'gray',
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
}

const light: Theme = {
  border: 'gray',
  borderActive: 'blue',
  selected: 'blue',
  unread: 'magenta',
  systemEvent: 'gray',
  selfMessage: 'blue',
  errorText: 'red',
  warnText: 'yellow',
  infoText: 'black',
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
}

export function getTheme(mode: ThemeMode): Theme {
  return mode === 'light' ? light : dark
}

// Legacy default export so any non-component code paths that still import
// `theme` directly keep working. New code should prefer useTheme().
export const theme = dark

export type PresenceColorKey = keyof typeof dark.presence
