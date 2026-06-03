// JSON config loader/persister for teaminal user preferences.
//
// Path: ${XDG_CONFIG_HOME ?? ~/.config}/teaminal/config.json
// Format: a JSON object containing any subset of Settings. Unknown keys are
// ignored with a warning; invalid values fall back to defaults.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CHAT_ROUTING_MODES,
  defaultSettings,
  type BorderStyleName,
  type ChatRoutingMode,
  type HeaderElementVisibility,
  type Settings,
  type ThemeOverrides,
  type ThemePresenceKey,
} from '../state/store'

export type ConfigSource = 'file' | 'defaults'
export type TeaminalConfig = Partial<Settings>

export type LoadResult = {
  settings: Settings
  config: TeaminalConfig
  source: ConfigSource
  warnings: string[]
  path: string
}

type Env = Record<string, string | undefined>

const THEME_KEYS = new Set<keyof ThemeOverrides>([
  'background',
  'text',
  'mutedText',
  'border',
  'borderActive',
  'selected',
  'selectedRow',
  'unread',
  'unreadRow',
  'timestamp',
  'sender',
  'selfMessage',
  'systemEvent',
  'errorText',
  'warnText',
  'infoText',
  'messageFocusIndicator',
  'messageFocusBackground',
  'selectedRowBackground',
  'presence',
  'layout',
  'borders',
  'emphasis',
])

const LAYOUT_KEYS = new Set<keyof NonNullable<ThemeOverrides['layout']>>([
  'panePaddingX',
  'modalPaddingX',
  'modalPaddingY',
  'paneHeaderPaddingLeft',
  'paneHeaderMarginBottom',
  'tailGap',
  'chatListPaddingRight',
])

const BORDERS_KEYS = new Set<keyof NonNullable<ThemeOverrides['borders']>>(['panel', 'modal'])

const EMPHASIS_KEYS = new Set<keyof NonNullable<ThemeOverrides['emphasis']>>([
  'modalTitleBold',
  'sectionHeadingBold',
  'selectedBold',
  'unreadBold',
  'senderBold',
  'inlineKeyBold',
])

const BORDER_STYLES = new Set<BorderStyleName>([
  'single',
  'double',
  'round',
  'bold',
  'classic',
  'singleDouble',
  'doubleSingle',
  'arrow',
])

const PRESENCE_KEYS = new Set<ThemePresenceKey>([
  'Available',
  'AvailableIdle',
  'Away',
  'BeRightBack',
  'Busy',
  'BusyIdle',
  'DoNotDisturb',
  'Offline',
  'OutOfOffice',
  'PresenceUnknown',
])

const NAMED_COLORS = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'grey',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
])

export function getConfigPath(env: Env = process.env): string {
  const xdg = env.XDG_CONFIG_HOME
  const base =
    xdg && xdg.length > 0
      ? xdg
      : join(env.HOME && env.HOME.length > 0 ? env.HOME : homedir(), '.config')
  return join(base, 'teaminal', 'config.json')
}

export function configPath(): string {
  return getConfigPath()
}

export function loadSettings(path: string = getConfigPath()): LoadResult {
  if (!existsSync(path)) {
    const settings = cloneSettings(defaultSettings)
    return {
      settings,
      config: settingsToConfig(settings),
      source: 'defaults',
      warnings: [],
      path,
    }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return defaultsWithWarning(path, `config: read failed: ${errMessage(err)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return defaultsWithWarning(path, `config: invalid JSON: ${errMessage(err)}`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return defaultsWithWarning(path, 'config: top-level must be a JSON object')
  }

  const warnings: string[] = []
  const settings = mergeSettings(parsed as Record<string, unknown>, warnings)
  return { settings, config: settingsToConfig(settings), source: 'file', warnings, path }
}

export async function loadConfig(path: string = getConfigPath()): Promise<LoadResult> {
  return loadSettings(path)
}

export async function saveConfig(
  config: TeaminalConfig,
  path: string = getConfigPath(),
): Promise<void> {
  const warnings: string[] = []
  const settings = configToSettings(config, warnings)
  writeConfigAtomically(settingsToConfig(settings), path)
}

export async function updateConfig(
  patch: TeaminalConfig,
  path: string = getConfigPath(),
): Promise<TeaminalConfig> {
  const current = loadSettings(path).settings
  const warnings: string[] = []
  const next = configToSettings(mergeConfigPatch(settingsToConfig(current), patch), warnings)
  writeConfigAtomically(settingsToConfig(next), path)
  return settingsToConfig(next)
}

export async function updateSettings(
  patch: Partial<Settings>,
  path: string = getConfigPath(),
): Promise<Settings> {
  const config = await updateConfig(patch, path)
  const warnings: string[] = []
  return configToSettings(config, warnings)
}

/**
 * Replace `themeOverrides` wholesale, validating through the same
 * validateThemeOverrides path used on load.
 *
 * updateSettings/updateConfig deep-MERGE themeOverrides (so a partial patch
 * can't clobber sibling tokens), which means they can never *remove* a key.
 * The live theme editor holds the complete override set in the store and
 * needs delete semantics for per-field / global reset, so it persists the
 * full object through this replace path instead.
 */
export async function replaceThemeOverrides(
  overrides: ThemeOverrides,
  path: string = getConfigPath(),
): Promise<Settings> {
  const current = loadSettings(path).settings
  const warnings: string[] = []
  const validated = validateThemeOverrides(overrides, warnings) ?? {}
  const next: Settings = { ...current, themeOverrides: validated }
  writeConfigAtomically(settingsToConfig(next), path)
  return next
}

export function configToSettings(
  config: Record<string, unknown>,
  warnings: string[] = [],
): Settings {
  return mergeSettings(config, warnings)
}

export function settingsToConfig(settings: Settings): TeaminalConfig {
  return {
    theme: settings.theme,
    themeOverrides: cloneThemeOverrides(settings.themeOverrides),
    accounts: [...settings.accounts],
    activeAccount: settings.activeAccount,
    chatListDensity: settings.chatListDensity,
    chatListSort: settings.chatListSort,
    chatListGroupByType: settings.chatListGroupByType,
    chatListShortNames: settings.chatListShortNames,
    showMessagePreviews: settings.showMessagePreviews,
    messagePaneShortNames: settings.messagePaneShortNames,
    showPresenceInList: settings.showPresenceInList,
    showTimestampsInPane: settings.showTimestampsInPane,
    showReactions: settings.showReactions,
    messageFocusIndicatorEnabled: settings.messageFocusIndicatorEnabled,
    messageFocusIndicatorChar: settings.messageFocusIndicatorChar,
    messageFocusIndicatorColor: settings.messageFocusIndicatorColor,
    messageFocusBackgroundColor: settings.messageFocusBackgroundColor,
    useTeamsPresence: settings.useTeamsPresence,
    forceAvailableWhenFocused: settings.forceAvailableWhenFocused,
    realtimeEnabled: settings.realtimeEnabled,
    notifyMuted: settings.notifyMuted,
    notifyActiveBanner: settings.notifyActiveBanner,
    quietHoursStart: settings.quietHoursStart,
    quietHoursEnd: settings.quietHoursEnd,
    logFile: settings.logFile,
    tailEvents: settings.tailEvents,
    tailNetwork: settings.tailNetwork,
    tailDiagnostics: settings.tailDiagnostics,
    selfMessagesOnRight: settings.selfMessagesOnRight,
    inlineImages: settings.inlineImages,
    inlineImageMaxRows: settings.inlineImageMaxRows,
    statusBarPosition: settings.statusBarPosition,
    headerElements: { ...settings.headerElements },
    headerUserFormat: settings.headerUserFormat,
    statusBarShowKeyHints: settings.statusBarShowKeyHints,
    chatRoutingByAccount: { ...settings.chatRoutingByAccount },
    chatListWidth: settings.chatListWidth,
    composerHeight: settings.composerHeight,
  }
}

export function mergeSettings(input: Record<string, unknown>, warnings: string[]): Settings {
  const out: Settings = cloneSettings(defaultSettings)
  for (const [key, value] of Object.entries(input)) {
    if (key === 'windowHeight') {
      continue
    }
    // Legacy key (pre chatRoutingByAccount): the binary audience preference.
    // An explicit 'graph'/'ic3' meant "with cross-audience fallback", so map
    // to the +fallback modes. Only fills accounts not already set by an
    // explicit chatRoutingByAccount, which always wins.
    if (key === 'audienceByAccount') {
      migrateLegacyAudienceByAccount(value, out)
      continue
    }
    if (!(key in defaultSettings)) {
      warnings.push(`config: unknown key "${key}" ignored`)
      continue
    }
    const k = key as keyof Settings
    validateAndAssign(out, k, value, warnings)
  }
  return out
}

function migrateLegacyAudienceByAccount(value: unknown, out: Settings): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  for (const [account, aud] of Object.entries(value)) {
    if (account in out.chatRoutingByAccount) continue
    if (aud === 'graph') out.chatRoutingByAccount[account] = 'graph+ic3'
    else if (aud === 'ic3') out.chatRoutingByAccount[account] = 'ic3+graph'
  }
}

function writeConfigAtomically(config: TeaminalConfig, path: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

function mergeConfigPatch(current: TeaminalConfig, patch: TeaminalConfig): TeaminalConfig {
  const next: TeaminalConfig = { ...current, ...patch }
  if (patch.themeOverrides) {
    next.themeOverrides = {
      ...(current.themeOverrides ?? {}),
      ...patch.themeOverrides,
      ...mergeNestedThemeOverride(current.themeOverrides, patch.themeOverrides, 'presence'),
      ...mergeNestedThemeOverride(current.themeOverrides, patch.themeOverrides, 'layout'),
      ...mergeNestedThemeOverride(current.themeOverrides, patch.themeOverrides, 'borders'),
      ...mergeNestedThemeOverride(current.themeOverrides, patch.themeOverrides, 'emphasis'),
    }
  }
  return next
}

function mergeNestedThemeOverride<K extends 'presence' | 'layout' | 'borders' | 'emphasis'>(
  current: ThemeOverrides | undefined,
  patch: ThemeOverrides,
  key: K,
): Pick<ThemeOverrides, K> {
  return {
    [key]: patch[key]
      ? {
          ...(current?.[key] ?? {}),
          ...patch[key],
        }
      : current?.[key],
  } as Pick<ThemeOverrides, K>
}

function defaultsWithWarning(path: string, warning: string): LoadResult {
  const settings = cloneSettings(defaultSettings)
  return {
    settings,
    config: settingsToConfig(settings),
    source: 'defaults',
    warnings: [warning],
    path,
  }
}

function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    accounts: [...settings.accounts],
    themeOverrides: cloneThemeOverrides(settings.themeOverrides),
    headerElements: { ...settings.headerElements },
    chatRoutingByAccount: { ...settings.chatRoutingByAccount },
  }
}

function cloneThemeOverrides(overrides: ThemeOverrides): ThemeOverrides {
  return {
    ...overrides,
    presence: overrides.presence ? { ...overrides.presence } : undefined,
    layout: overrides.layout ? { ...overrides.layout } : undefined,
    borders: overrides.borders ? { ...overrides.borders } : undefined,
    emphasis: overrides.emphasis ? { ...overrides.emphasis } : undefined,
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function validateAndAssign(
  out: Settings,
  key: keyof Settings,
  value: unknown,
  warnings: string[],
): boolean {
  switch (key) {
    case 'theme':
      if (typeof value === 'string' && value.trim().length > 0) {
        out.theme = value.trim()
        return true
      }
      warnings.push('config: "theme" must be a non-empty string')
      return false
    case 'themeOverrides': {
      const overrides = validateThemeOverrides(value, warnings)
      if (!overrides) return false
      out.themeOverrides = overrides
      return true
    }
    case 'accounts':
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        out.accounts = [...new Set(value.map((v) => v.trim()).filter(Boolean))]
        return true
      }
      warnings.push('config: "accounts" must be an array of profile names')
      return false
    case 'activeAccount':
      if (value === null) {
        out.activeAccount = null
        return true
      }
      if (typeof value === 'string') {
        const trimmed = value.trim()
        out.activeAccount = trimmed.length > 0 ? trimmed : null
        return true
      }
      warnings.push('config: "activeAccount" must be null or a profile name')
      return false
    case 'chatListDensity':
      if (value === 'cozy' || value === 'compact') {
        out.chatListDensity = value
        return true
      }
      warnings.push('config: "chatListDensity" must be "cozy" or "compact"')
      return false
    case 'chatListSort':
      if (value === 'recent' || value === 'alphabetical') {
        out.chatListSort = value
        return true
      }
      warnings.push('config: "chatListSort" must be "recent" or "alphabetical"')
      return false
    case 'headerUserFormat':
      if (value === 'full' || value === 'tenant') {
        out.headerUserFormat = value
        return true
      }
      warnings.push('config: "headerUserFormat" must be "full" or "tenant"')
      return false
    case 'chatListGroupByType':
    case 'chatListShortNames':
    case 'showMessagePreviews':
    case 'messagePaneShortNames':
    case 'showPresenceInList':
    case 'showTimestampsInPane':
    case 'messageFocusIndicatorEnabled':
    case 'useTeamsPresence':
    case 'forceAvailableWhenFocused':
    case 'realtimeEnabled':
    case 'notifyMuted':
    case 'notifyActiveBanner':
    case 'tailEvents':
    case 'tailNetwork':
    case 'tailDiagnostics':
    case 'selfMessagesOnRight':
    case 'statusBarShowKeyHints':
      if (typeof value === 'boolean') {
        out[key] = value
        return true
      }
      warnings.push(`config: "${key}" must be a boolean`)
      return false
    case 'headerElements': {
      const parsed = validateHeaderElements(value, warnings)
      if (parsed) {
        // Merge over defaults so an omitted segment keeps its default.
        out.headerElements = { ...out.headerElements, ...parsed }
        return true
      }
      return false
    }
    case 'showReactions':
      if (value === 'off' || value === 'current' || value === 'all') {
        out.showReactions = value
        return true
      }
      warnings.push('config: "showReactions" must be "off", "current", or "all"')
      return false
    case 'messageFocusIndicatorChar':
      if (typeof value === 'string' && Array.from(value).length === 1) {
        out.messageFocusIndicatorChar = value
        return true
      }
      warnings.push('config: "messageFocusIndicatorChar" must be a single character')
      return false
    case 'messageFocusIndicatorColor':
    case 'messageFocusBackgroundColor':
      if (value === null) {
        out[key] = null
        return true
      }
      if (isColor(value)) {
        out[key] = value
        return true
      }
      warnings.push(`config: "${key}" must be null, a named color, or a hex color`)
      return false
    case 'quietHoursStart':
    case 'quietHoursEnd':
      if (value === null) {
        out[key] = null
        return true
      }
      if (typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value.trim())) {
        out[key] = value.trim()
        return true
      }
      warnings.push(`config: "${key}" must be null or an HH:MM string`)
      return false
    case 'logFile':
      if (value === null) {
        out.logFile = null
        return true
      }
      if (typeof value === 'string') {
        const trimmed = value.trim()
        out.logFile = trimmed.length > 0 ? trimmed : null
        return true
      }
      warnings.push('config: "logFile" must be null or a path string')
      return false
    case 'inlineImages':
      if (value === 'auto' || value === 'off') {
        out.inlineImages = value
        return true
      }
      warnings.push('config: "inlineImages" must be "auto" or "off"')
      return false
    case 'inlineImageMaxRows':
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 50) {
        out.inlineImageMaxRows = value
        return true
      }
      warnings.push('config: "inlineImageMaxRows" must be an integer between 1 and 50')
      return false
    case 'statusBarPosition':
      if (value === 'bottom' || value === 'top' || value === 'hidden') {
        out.statusBarPosition = value
        return true
      }
      warnings.push('config: "statusBarPosition" must be "bottom", "top", or "hidden"')
      return false
    case 'chatRoutingByAccount': {
      const parsed = validateChatRoutingByAccount(value, warnings)
      if (parsed) {
        // Merge rather than replace so a legacy audienceByAccount migration
        // (see mergeSettings) isn't clobbered regardless of key order.
        out.chatRoutingByAccount = { ...out.chatRoutingByAccount, ...parsed }
        return true
      }
      return false
    }
    case 'chatListWidth':
      if (value === null) {
        out.chatListWidth = null
        return true
      }
      if (typeof value === 'number' && Number.isInteger(value) && value >= 12 && value <= 120) {
        out.chatListWidth = value
        return true
      }
      warnings.push('config: "chatListWidth" must be null or an integer between 12 and 120')
      return false
    case 'composerHeight':
      if (value === null) {
        out.composerHeight = null
        return true
      }
      if (typeof value === 'number' && Number.isInteger(value) && value >= 3 && value <= 20) {
        out.composerHeight = value
        return true
      }
      warnings.push('config: "composerHeight" must be null or an integer between 3 and 20')
      return false
  }
}

const HEADER_ELEMENT_KEYS: (keyof HeaderElementVisibility)[] = [
  'app',
  'user',
  'presence',
  'graph',
  'chats',
  'unread',
  'push',
  'updated',
]

function validateHeaderElements(
  value: unknown,
  warnings: string[],
): Partial<HeaderElementVisibility> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push('config: "headerElements" must be a JSON object')
    return null
  }
  const out: Partial<HeaderElementVisibility> = {}
  for (const [key, val] of Object.entries(value)) {
    if (!HEADER_ELEMENT_KEYS.includes(key as keyof HeaderElementVisibility)) {
      warnings.push(`config: headerElements["${key}"] is not a known segment — ignored`)
      continue
    }
    if (typeof val !== 'boolean') {
      warnings.push(`config: headerElements["${key}"] must be a boolean — ignored`)
      continue
    }
    out[key as keyof HeaderElementVisibility] = val
  }
  return out
}

function validateChatRoutingByAccount(
  value: unknown,
  warnings: string[],
): Record<string, ChatRoutingMode> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push('config: "chatRoutingByAccount" must be a JSON object')
    return null
  }
  const out: Record<string, ChatRoutingMode> = {}
  for (const [account, mode] of Object.entries(value)) {
    if (CHAT_ROUTING_MODES.includes(mode as ChatRoutingMode)) {
      out[account] = mode as ChatRoutingMode
    } else {
      warnings.push(
        `config: chatRoutingByAccount["${account}"] must be one of ${CHAT_ROUTING_MODES.join('/')} — ignored`,
      )
    }
  }
  return out
}

export function validateThemeOverrides(value: unknown, warnings: string[]): ThemeOverrides | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push('config: "themeOverrides" must be a JSON object')
    return null
  }

  const out: ThemeOverrides = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey as keyof ThemeOverrides
    if (!THEME_KEYS.has(key)) {
      warnings.push(`config: unknown themeOverrides key "${rawKey}" ignored`)
      continue
    }

    if (key === 'presence') {
      const presence = validatePresenceOverrides(rawValue, warnings)
      if (presence) out.presence = presence
      continue
    }

    if (key === 'layout') {
      const layout = validateLayoutOverrides(rawValue, warnings)
      if (layout) out.layout = layout
      continue
    }

    if (key === 'borders') {
      const borders = validateBordersOverrides(rawValue, warnings)
      if (borders) out.borders = borders
      continue
    }

    if (key === 'emphasis') {
      const emphasis = validateEmphasisOverrides(rawValue, warnings)
      if (emphasis) out.emphasis = emphasis
      continue
    }

    if (
      (key === 'messageFocusBackground' || key === 'selectedRowBackground') &&
      rawValue === null
    ) {
      ;(out[key] as string | null) = null
      continue
    }

    if (isColor(rawValue)) {
      ;(out[key] as string | null | undefined) = rawValue
      continue
    }

    warnings.push(`config: "themeOverrides.${rawKey}" must be a named color or hex color`)
  }
  return out
}

export function validateLayoutOverrides(
  value: unknown,
  warnings: string[],
  scope = 'themeOverrides.layout',
): NonNullable<ThemeOverrides['layout']> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`config: "${scope}" must be a JSON object`)
    return null
  }
  const out: NonNullable<ThemeOverrides['layout']> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!LAYOUT_KEYS.has(rawKey as keyof NonNullable<ThemeOverrides['layout']>)) {
      warnings.push(`config: unknown ${scope} key "${rawKey}" ignored`)
      continue
    }
    if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 0) {
      warnings.push(`config: "${scope}.${rawKey}" must be a non-negative integer`)
      continue
    }
    ;(out as Record<string, number>)[rawKey] = rawValue
  }
  return out
}

export function validateBordersOverrides(
  value: unknown,
  warnings: string[],
  scope = 'themeOverrides.borders',
): NonNullable<ThemeOverrides['borders']> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`config: "${scope}" must be a JSON object`)
    return null
  }
  const out: NonNullable<ThemeOverrides['borders']> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!BORDERS_KEYS.has(rawKey as keyof NonNullable<ThemeOverrides['borders']>)) {
      warnings.push(`config: unknown ${scope} key "${rawKey}" ignored`)
      continue
    }
    if (typeof rawValue !== 'string' || !BORDER_STYLES.has(rawValue as BorderStyleName)) {
      warnings.push(
        `config: "${scope}.${rawKey}" must be one of ${Array.from(BORDER_STYLES).join(', ')}`,
      )
      continue
    }
    ;(out as Record<string, BorderStyleName>)[rawKey] = rawValue as BorderStyleName
  }
  return out
}

export function validateEmphasisOverrides(
  value: unknown,
  warnings: string[],
  scope = 'themeOverrides.emphasis',
): NonNullable<ThemeOverrides['emphasis']> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`config: "${scope}" must be a JSON object`)
    return null
  }
  const out: NonNullable<ThemeOverrides['emphasis']> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!EMPHASIS_KEYS.has(rawKey as keyof NonNullable<ThemeOverrides['emphasis']>)) {
      warnings.push(`config: unknown ${scope} key "${rawKey}" ignored`)
      continue
    }
    if (typeof rawValue !== 'boolean') {
      warnings.push(`config: "${scope}.${rawKey}" must be a boolean`)
      continue
    }
    ;(out as Record<string, boolean>)[rawKey] = rawValue
  }
  return out
}

function validatePresenceOverrides(
  value: unknown,
  warnings: string[],
): Partial<Record<ThemePresenceKey, string>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push('config: "themeOverrides.presence" must be a JSON object')
    return null
  }

  const out: Partial<Record<ThemePresenceKey, string>> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!PRESENCE_KEYS.has(rawKey as ThemePresenceKey)) {
      warnings.push(`config: unknown themeOverrides.presence key "${rawKey}" ignored`)
      continue
    }
    if (!isColor(rawValue)) {
      warnings.push(
        `config: "themeOverrides.presence.${rawKey}" must be a named color or hex color`,
      )
      continue
    }
    out[rawKey as ThemePresenceKey] = rawValue
  }
  return out
}

function isColor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (NAMED_COLORS.has(value) || /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(value))
  )
}
