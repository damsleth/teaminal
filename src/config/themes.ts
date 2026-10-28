// Loader for user theme files at ~/.config/teaminal/themes/<name>.json.
//
// A theme file is a partial Theme: any subset of color tokens, the
// `presence`, `layout`, `borders`, `emphasis` sub-objects, plus a `settings`
// block of UI settings applied when the preset loads. It is layered
// between the built-in base ('dark') and Settings.themeOverrides during
// resolution (see src/ui/theme.ts:resolveTheme).
//
// This loader only validates and returns the parsed object. Resolution
// (and falling back to the built-in 'dark' base when the theme name is
// unknown) happens in src/ui/theme.ts.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  validateBordersOverrides,
  validateEmphasisOverrides,
  validateFontSizeOverrides,
  validateLayoutOverrides,
  validatePresetSettings,
} from './index'

type Env = Record<string, string | undefined>

export type LoadedTheme = {
  name: string
  path: string
  data: Record<string, unknown> | null
  warnings: string[]
  source: 'file' | 'missing' | 'builtin'
}

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

const COLOR_KEYS = new Set([
  'modalBackground',
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
  'selfName',
  'systemEvent',
  'dateMarker',
  'errorText',
  'warnText',
  'infoText',
  'messageFocusIndicator',
])

const NULLABLE_COLOR_KEYS = new Set([
  'selfMessage',
  'modalBackground',
  'appBackground',
  'messageFocusBackground',
  'selectedRowBackground',
  'selfMessageBackground',
  'senderMessage',
  'senderMessageBackground',
  'messageFocusText',
])

const PRESENCE_KEYS = new Set([
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

export function getThemesDir(env: Env = process.env): string {
  const xdg = env.XDG_CONFIG_HOME
  const base =
    xdg && xdg.length > 0
      ? xdg
      : join(env.HOME && env.HOME.length > 0 ? env.HOME : homedir(), '.config')
  return join(base, 'teaminal', 'themes')
}

export function getThemePath(name: string, env: Env = process.env): string {
  return join(getThemesDir(env), `${name}.json`)
}

export function ensureThemesDir(env: Env = process.env): void {
  const dir = getThemesDir(env)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// Built-in names short-circuit — there is no on-disk file to load. 'auto'
// is a mode (resolves to dark/light at render time), not a file either.
const BUILTIN_NAMES = new Set(['auto', 'dark', 'light'])

export function loadThemeFile(name: string, env: Env = process.env): LoadedTheme {
  const path = getThemePath(name, env)
  if (BUILTIN_NAMES.has(name)) {
    return { name, path, data: null, warnings: [], source: 'builtin' }
  }
  if (!existsSync(path)) {
    return {
      name,
      path,
      data: null,
      warnings: [`theme: file not found at ${path}, falling back to "dark"`],
      source: 'missing',
    }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return failure(name, path, `theme: read failed: ${errMessage(err)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return failure(name, path, `theme: invalid JSON in ${path}: ${errMessage(err)}`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failure(name, path, `theme: ${path} top-level must be a JSON object`)
  }

  const warnings: string[] = []
  const data = validatePartialTheme(parsed as Record<string, unknown>, warnings)
  return { name, path, data, warnings, source: 'file' }
}

// Preset names become file names: keep them to a safe charset (no path
// separators, no leading dot) and off the built-in names.
const PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,40}$/

export function isValidPresetName(name: string): boolean {
  return PRESET_NAME_RE.test(name) && !BUILTIN_NAMES.has(name) && !name.endsWith('.')
}

export function isBuiltinThemeName(name: string): boolean {
  return BUILTIN_NAMES.has(name)
}

// Saved presets, by name, sorted.
export function listThemePresets(env: Env = process.env): string[] {
  const dir = getThemesDir(env)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter(isValidPresetName)
    .sort((a, b) => a.localeCompare(b))
}

export function writeThemePreset(
  name: string,
  data: Record<string, unknown>,
  env: Env = process.env,
): void {
  if (!isValidPresetName(name)) throw new Error(`invalid theme name "${name}"`)
  ensureThemesDir(env)
  const path = getThemePath(name, env)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, path)
}

export function deleteThemePreset(name: string, env: Env = process.env): void {
  if (!isValidPresetName(name)) throw new Error(`invalid theme name "${name}"`)
  rmSync(getThemePath(name, env), { force: true })
}

function failure(name: string, path: string, message: string): LoadedTheme {
  return { name, path, data: null, warnings: [message], source: 'missing' }
}

// Returns a sanitised partial-theme object, dropping unknown/invalid
// keys with warnings. Mirrors validateThemeOverrides but applied to the
// flat-file shape.
function validatePartialTheme(
  input: Record<string, unknown>,
  warnings: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(input)) {
    // `background` is the pre-0.25 name of modalBackground.
    const key = rawKey === 'background' ? 'modalBackground' : rawKey
    // The built-in palette the preset layers on. Absent means 'dark'.
    if (key === 'base') {
      if (value === 'dark' || value === 'light') out.base = value
      else warnings.push('theme: "base" must be "dark" or "light"')
      continue
    }
    if (key === 'presence') {
      const presence = validatePresence(value, warnings)
      if (presence) out.presence = presence
      continue
    }
    if (key === 'layout') {
      const layout = validateLayoutOverrides(value, warnings, 'theme.layout')
      if (layout && Object.keys(layout).length > 0) out.layout = layout
      continue
    }
    if (key === 'borders') {
      const borders = validateBordersOverrides(value, warnings, 'theme.borders')
      if (borders && Object.keys(borders).length > 0) out.borders = borders
      continue
    }
    if (key === 'emphasis') {
      const emphasis = validateEmphasisOverrides(value, warnings, 'theme.emphasis')
      if (emphasis && Object.keys(emphasis).length > 0) out.emphasis = emphasis
      continue
    }
    if (key === 'fontSize') {
      const fontSize = validateFontSizeOverrides(value, warnings, 'theme.fontSize')
      if (fontSize && Object.keys(fontSize).length > 0) out.fontSize = fontSize
      continue
    }
    // UI settings (Settings menu toggles) the preset applies when loaded.
    if (key === 'settings') {
      const settings = validatePresetSettings(value, warnings)
      if (settings && Object.keys(settings).length > 0) out.settings = settings
      continue
    }
    if (NULLABLE_COLOR_KEYS.has(key)) {
      if (value === null || isColor(value)) {
        out[key] = value
      } else {
        warnings.push(`theme: "${key}" must be null, a named color, or hex`)
      }
      continue
    }
    if (!COLOR_KEYS.has(key)) {
      warnings.push(`theme: unknown key "${key}" ignored`)
      continue
    }
    if (!isColor(value)) {
      warnings.push(`theme: "${key}" must be a named color or hex color`)
      continue
    }
    out[key] = value
  }
  return out
}

function validatePresence(value: unknown, warnings: string[]): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push('theme: "presence" must be a JSON object')
    return null
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!PRESENCE_KEYS.has(k)) {
      warnings.push(`theme: unknown presence key "${k}" ignored`)
      continue
    }
    if (!isColor(v)) {
      warnings.push(`theme: "presence.${k}" must be a named color or hex color`)
      continue
    }
    out[k] = v
  }
  return out
}

function isColor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (NAMED_COLORS.has(value) || /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value))
  )
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
