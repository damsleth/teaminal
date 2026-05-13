// Loader for user theme files at ~/.config/teaminal/themes/<name>.json.
//
// A theme file is a partial Theme: any subset of color tokens, the
// `presence`, `layout`, `borders`, `emphasis` sub-objects. It is layered
// between the built-in base ('dark') and Settings.themeOverrides during
// resolution (see src/ui/theme.ts:resolveTheme).
//
// This loader only validates and returns the parsed object. Resolution
// (and falling back to the built-in 'dark' base when the theme name is
// unknown) happens in src/ui/theme.ts.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  validateBordersOverrides,
  validateEmphasisOverrides,
  validateLayoutOverrides,
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

// Built-in names short-circuit — there is no on-disk file to load.
const BUILTIN_NAMES = new Set(['dark', 'light', 'compact', 'comfortable'])

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
  for (const [key, value] of Object.entries(input)) {
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
    if (key === 'messageFocusBackground') {
      if (value === null || isColor(value)) {
        out.messageFocusBackground = value
      } else {
        warnings.push('theme: "messageFocusBackground" must be null, a named color, or hex')
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
    (NAMED_COLORS.has(value) || /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(value))
  )
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
