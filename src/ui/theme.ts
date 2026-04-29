// Color and style constants. Ink color names map to chalk; see
// https://github.com/chalk/chalk for the full palette.
//
// Keep this file dumb and centralized so the eventual `theme=...` config key
// can swap palettes without touching component code.

export const theme = {
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
  } as const,
} as const

export type PresenceColorKey = keyof typeof theme.presence
