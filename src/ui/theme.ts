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

import type {
  Settings,
  SystemAppearance,
  ThemeColorOverrides,
  ThemeFontSizeKey,
  ThemeOverrides,
  ThemePresenceKey,
} from '../state/store'

export type PresenceMap = Record<ThemePresenceKey, string>

// Ink supports these border styles. We don't expose a separate
// "thickness" abstraction — pick the style directly. 'none' is ours: see
// inkBorder.
export const BORDER_STYLES = [
  'none',
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

// ponytail: 'none' draws a blank border instead of dropping it, so pane
// geometry (and every width/height computed from it) stays identical.
const BLANK_BORDER = {
  topLeft: ' ',
  top: ' ',
  topRight: ' ',
  right: ' ',
  bottomRight: ' ',
  bottom: ' ',
  bottomLeft: ' ',
  left: ' ',
}
export function inkBorder(style: BorderStyle): Exclude<BorderStyle, 'none'> | typeof BLANK_BORDER {
  return style === 'none' ? BLANK_BORDER : style
}

export type ThemeLayout = {
  // paddingX on the App outer box, Composer, HeaderBar, StatusBar,
  // TailPanels strips, ErrorBoundary.
  panePaddingX: number
  // paddingX/paddingY on every modal frame and the new-chat prompt.
  modalPaddingX: number
  modalPaddingY: number
  // MessagePane: left indent of message bodies (and the cozy chat-name
  // header, which aligns with them). Sender name + body share this indent.
  paneHeaderPaddingLeft: number
  // MessagePane: blank rows inserted after each message group, separating
  // one sender's name+body block from the next.
  paneHeaderMarginBottom: number
  // Horizontal gap between TailPanels strips.
  tailGap: number
  // ChatList right-side gutter.
  chatListPaddingRight: number
  // ChatList: blank rows after each chat/channel row.
  chatListGap: number
}

export type ThemeBorders = {
  // App panes + TailPanels container (paired with theme.border).
  panel: BorderStyle
  // Modal frames + new-chat prompt (paired with theme.borderActive).
  modal: BorderStyle
  // The pane that has input (chat list, conversation, composer), paired with
  // theme.borderActive. Inactive panes keep `panel` + theme.border.
  active: BorderStyle
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

// Percent of the base font size per text type (see src/ui/textSizing.ts).
// tightSpacing: one-line elements pack letters to the scaled pitch.
export type ThemeFontSize = Record<ThemeFontSizeKey, number> & { tightSpacing: boolean }

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
  fontSize: ThemeFontSize
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
  // Message body indent (cols) and gap between message groups (rows).
  paneHeaderPaddingLeft: 2,
  paneHeaderMarginBottom: 1,
  tailGap: 1,
  chatListPaddingRight: 1,
  chatListGap: 0,
}

const BORDERS_DEFAULT: ThemeBorders = { panel: 'round', modal: 'round', active: 'round' }

const EMPHASIS_DEFAULT: ThemeEmphasis = {
  modalTitleBold: true,
  sectionHeadingBold: true,
  selectedBold: true,
  unreadBold: true,
  senderBold: true,
  inlineKeyBold: true,
}

const FONT_SIZE_DEFAULT: ThemeFontSize = {
  timestamp: 100,
  sender: 100,
  messageText: 100,
  paneHeader: 100,
  chatListHeader: 100,
  chatListName: 100,
  chatListPreview: 100,
  tightSpacing: true,
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
  // Very muted by default: timestamps sit beside the sender name and should
  // recede almost into the background until you look for them.
  timestamp: '#1c1c1c',
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
  fontSize: FONT_SIZE_DEFAULT,
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
  // Very muted: near-background gray that recedes against the light theme.
  timestamp: '#e6e6e6',
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
  fontSize: FONT_SIZE_DEFAULT,
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
  fontSize?: Partial<ThemeFontSize>
}

// Built-in base a theme setting renders on: 'auto' follows the OS, a user
// theme file (any other name) layers on 'dark'.
export function resolveBaseName(
  themeSetting: string,
  systemAppearance: SystemAppearance = 'dark',
): BuiltinThemeName {
  const requested = themeSetting === 'auto' ? systemAppearance : themeSetting
  return isBuiltinTheme(requested) ? requested : 'dark'
}

export function resolveTheme(
  settings: Settings,
  customTheme?: PartialTheme | null,
  systemAppearance: SystemAppearance = 'dark',
): Theme {
  // 'auto' follows the OS appearance; everything else is a literal theme
  // name (built-in or a user theme file, which falls back to 'dark').
  const baseName = resolveBaseName(settings.theme, systemAppearance)
  const base = cloneTheme(builtinThemes[baseName])
  const withCustom = customTheme ? mergePartial(base, customTheme) : base
  const merged = applyOverrides(withCustom, settings.themeOverrides, baseName)

  if (settings.messageFocusIndicatorColor) {
    merged.messageFocusIndicator = settings.messageFocusIndicatorColor
  }
  if (settings.messageFocusBackgroundColor !== null) {
    merged.messageFocusBackground = settings.messageFocusBackgroundColor
  }

  return merged
}

function mergePartial(theme: Theme, partial: PartialTheme): Theme {
  const { presence, layout, borders, emphasis, fontSize, ...flat } = partial
  for (const [key, value] of Object.entries(flat) as [keyof PartialTheme, unknown][]) {
    if (value !== undefined) {
      ;(theme as Record<string, unknown>)[key] = value
    }
  }
  if (presence) theme.presence = { ...theme.presence, ...presence }
  if (layout) theme.layout = { ...theme.layout, ...layout }
  if (borders) theme.borders = { ...theme.borders, ...borders }
  if (emphasis) theme.emphasis = { ...theme.emphasis, ...emphasis }
  if (fontSize) theme.fontSize = { ...theme.fontSize, ...fontSize }
  return theme
}

function applyOverrides(
  theme: Theme,
  overrides: ThemeOverrides,
  baseName: BuiltinThemeName,
): Theme {
  const { presence, layout, borders, emphasis, fontSize, dark, light, ...flat } = overrides
  // Global (legacy) colors first, then the active base's own colors.
  applyColors(theme, flat)
  applyColors(theme, baseName === 'light' ? light : dark)
  if (presence) theme.presence = { ...theme.presence, ...presence }
  if (layout) theme.layout = { ...theme.layout, ...layout }
  if (borders) theme.borders = { ...theme.borders, ...borders }
  if (emphasis) theme.emphasis = { ...theme.emphasis, ...emphasis }
  if (fontSize) theme.fontSize = { ...theme.fontSize, ...fontSize }
  return theme
}

function applyColors(theme: Theme, colors: ThemeColorOverrides | undefined): void {
  for (const [key, value] of Object.entries(colors ?? {}) as [
    keyof ThemeColorOverrides,
    string | null | undefined,
  ][]) {
    if (value !== undefined) {
      ;(theme[key] as string | null) = value
    }
  }
}

function cloneTheme(input: Theme): Theme {
  return {
    ...input,
    presence: { ...input.presence },
    layout: { ...input.layout },
    borders: { ...input.borders },
    emphasis: { ...input.emphasis },
    fontSize: { ...input.fontSize },
  }
}

// Legacy default export so any non-component code paths that still import
// `theme` directly keep working. New code should prefer useTheme().
export const theme = getTheme('dark')

export type PresenceColorKey = ThemePresenceKey
