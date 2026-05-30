// Layered color and style resolver. Ink color strings are passed through to
// chalk, so config validation accepts common named colors plus hex strings.
//
// A Theme is a flat record of colors, plus three sub-objects that group
// related layout/border/emphasis tokens. Built-in themes (`dark`, `light`)
// live in this file; `auto` is not a base theme but a mode that resolves to
// `dark` or `light` from the OS appearance at render time. User themes live
// as JSON files under ~/.config/teaminal/themes/<name>.json (loaded by
// src/config/themes.ts) and are layered between the resolved built-in base
// and Settings.themeOverrides.

import type { Settings, SystemAppearance, ThemeOverrides, ThemePresenceKey } from '../state/store'

export type PresenceMap = Record<ThemePresenceKey, string>

// Ink supports these border styles. We don't expose a separate
// "thickness" abstraction — pick the style directly.
export const BORDER_STYLES = [
  'single',
  'double',
  'round',
  'bold',
  'classic',
  'singleDouble',
  'doubleSingle',
  'arrow',
] as const
export type BorderStyle = (typeof BORDER_STYLES)[number]

export type ThemeLayout = {
  // paddingX on the App outer box, Composer, HeaderBar, StatusBar,
  // TailPanels strips, ErrorBoundary.
  panePaddingX: number
  // paddingX/paddingY on every modal frame and the new-chat prompt.
  modalPaddingX: number
  modalPaddingY: number
  // MessagePane cozy header offset.
  paneHeaderPaddingLeft: number
  paneHeaderMarginBottom: number
  // Horizontal gap between TailPanels strips.
  tailGap: number
  // ChatList right-side gutter.
  chatListPaddingRight: number
}

export type ThemeBorders = {
  // App panes + TailPanels container (paired with theme.border).
  panel: BorderStyle
  // Modal frames + new-chat prompt (paired with theme.borderActive).
  modal: BorderStyle
}

export type ThemeEmphasis = {
  modalTitleBold: boolean
  // DiagnosticsModal subsection labels, ChatList "Chats" header,
  // MessagePane cozy chat-name header.
  sectionHeadingBold: boolean
  // ChatList / MenuModal / AccountsModal / NewChatPrompt selected rows.
  selectedBold: boolean
  // ChatList unread previews.
  unreadBold: boolean
  // MessagePane sender column.
  senderBold: boolean
  // AuthExpiredModal inline hint glyphs ("r", "s", "q").
  inlineKeyBold: boolean
}

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
  selectedRowBackground: string | null
  presence: PresenceMap
  layout: ThemeLayout
  borders: ThemeBorders
  emphasis: ThemeEmphasis
}

const PRESENCE_DARK: PresenceMap = {
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
}

// Default layout matches today's rendered values after normalizing the
// EventsModal/NetworkModal padding drift (2 → 3).
const LAYOUT_DEFAULT: ThemeLayout = {
  panePaddingX: 1,
  modalPaddingX: 3,
  modalPaddingY: 1,
  paneHeaderPaddingLeft: 1,
  paneHeaderMarginBottom: 1,
  tailGap: 1,
  chatListPaddingRight: 1,
}

const BORDERS_DEFAULT: ThemeBorders = { panel: 'round', modal: 'round' }

const EMPHASIS_DEFAULT: ThemeEmphasis = {
  modalTitleBold: true,
  sectionHeadingBold: true,
  selectedBold: true,
  unreadBold: true,
  senderBold: true,
  inlineKeyBold: true,
}

// Concrete base themes only. `auto` is a mode (resolves to one of these from
// the OS appearance) and is intentionally not listed here.
export const BUILTIN_THEME_NAMES = ['dark', 'light'] as const
export type BuiltinThemeName = (typeof BUILTIN_THEME_NAMES)[number]

export function isBuiltinTheme(name: string): name is BuiltinThemeName {
  return (BUILTIN_THEME_NAMES as readonly string[]).includes(name)
}

const DARK: Theme = {
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
  selectedRowBackground: '#262626',
  presence: PRESENCE_DARK,
  layout: LAYOUT_DEFAULT,
  borders: BORDERS_DEFAULT,
  emphasis: EMPHASIS_DEFAULT,
}

// The light theme uses explicit hex values for its background and dark-text
// tokens rather than the named ANSI colors 'white' / 'black'. Named ANSI
// colors resolve through the terminal's 16-color palette, and many light
// palettes (e.g. Ghostty's Kanso Pearl) map color-7 ("white") to a muted
// gray rather than the light terminal background — which made the menu /
// modal backgrounds render dark under the light theme. Hex is palette-
// independent on truecolor terminals.
const LIGHT: Theme = {
  background: '#ffffff',
  text: '#1c1c1c',
  mutedText: 'gray',
  border: 'gray',
  borderActive: 'blue',
  selected: 'blue',
  selectedRow: 'blue',
  unread: 'magenta',
  unreadRow: 'magenta',
  timestamp: 'gray',
  sender: '#1c1c1c',
  selfMessage: 'blue',
  systemEvent: 'gray',
  errorText: 'red',
  warnText: 'yellow',
  infoText: '#1c1c1c',
  messageFocusIndicator: 'blue',
  messageFocusBackground: null,
  selectedRowBackground: '#e6e6e6',
  presence: PRESENCE_DARK,
  layout: LAYOUT_DEFAULT,
  borders: BORDERS_DEFAULT,
  emphasis: EMPHASIS_DEFAULT,
}

export const builtinThemes: Record<BuiltinThemeName, Theme> = {
  dark: DARK,
  light: LIGHT,
}

export function getTheme(mode: string): Theme {
  const base = isBuiltinTheme(mode) ? builtinThemes[mode] : builtinThemes.dark
  return cloneTheme(base)
}

// Partial theme as loaded from a user theme JSON file. Same shape as
// Theme but every field optional, with sub-objects partial too.
export type PartialTheme = {
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
  selectedRowBackground?: string | null
  presence?: Partial<PresenceMap>
  layout?: Partial<ThemeLayout>
  borders?: Partial<ThemeBorders>
  emphasis?: Partial<ThemeEmphasis>
}

export function resolveTheme(
  settings: Settings,
  customTheme?: PartialTheme | null,
  systemAppearance: SystemAppearance = 'dark',
): Theme {
  // 'auto' follows the OS appearance; everything else is a literal theme
  // name (built-in or a user theme file, which falls back to 'dark').
  const requested = settings.theme === 'auto' ? systemAppearance : settings.theme
  const baseName = isBuiltinTheme(requested) ? requested : 'dark'
  const base = cloneTheme(builtinThemes[baseName])
  const withCustom = customTheme ? mergePartial(base, customTheme) : base
  const merged = applyOverrides(withCustom, settings.themeOverrides)

  if (settings.messageFocusIndicatorColor) {
    merged.messageFocusIndicator = settings.messageFocusIndicatorColor
  }
  if (settings.messageFocusBackgroundColor !== null) {
    merged.messageFocusBackground = settings.messageFocusBackgroundColor
  }

  return merged
}

function mergePartial(theme: Theme, partial: PartialTheme): Theme {
  const { presence, layout, borders, emphasis, ...flat } = partial
  for (const [key, value] of Object.entries(flat) as [keyof PartialTheme, unknown][]) {
    if (value !== undefined) {
      ;(theme as Record<string, unknown>)[key] = value
    }
  }
  if (presence) theme.presence = { ...theme.presence, ...presence }
  if (layout) theme.layout = { ...theme.layout, ...layout }
  if (borders) theme.borders = { ...theme.borders, ...borders }
  if (emphasis) theme.emphasis = { ...theme.emphasis, ...emphasis }
  return theme
}

function applyOverrides(theme: Theme, overrides: ThemeOverrides): Theme {
  const { presence, layout, borders, emphasis, ...flat } = overrides
  for (const [key, value] of Object.entries(flat) as [
    keyof Omit<ThemeOverrides, 'presence' | 'layout' | 'borders' | 'emphasis'>,
    string | null | undefined,
  ][]) {
    if (value !== undefined) {
      ;(theme[key] as string | null) = value
    }
  }
  if (presence) theme.presence = { ...theme.presence, ...presence }
  if (layout) theme.layout = { ...theme.layout, ...layout }
  if (borders) theme.borders = { ...theme.borders, ...borders }
  if (emphasis) theme.emphasis = { ...theme.emphasis, ...emphasis }
  return theme
}

function cloneTheme(input: Theme): Theme {
  return {
    ...input,
    presence: { ...input.presence },
    layout: { ...input.layout },
    borders: { ...input.borders },
    emphasis: { ...input.emphasis },
  }
}

// Legacy default export so any non-component code paths that still import
// `theme` directly keep working. New code should prefer useTheme().
export const theme = getTheme('dark')

export type PresenceColorKey = ThemePresenceKey
