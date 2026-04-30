// JSON config loader for teaminal user preferences.
//
// Path: ${XDG_CONFIG_HOME ?? ~/.config}/teaminal/config.json
// Format: any subset of the Settings type (theme, chatListDensity,
// chatListShortNames, showPresenceInList, showTimestampsInPane,
// windowHeight). Unknown keys are ignored with a warning; values of
// the wrong shape fall back to the default.
//
// Loaded once at startup. In-app changes via the Settings menu are
// in-process only until on-disk persistence lands (see TODO.md).

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, type Settings } from '../state/store'

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'teaminal', 'config.json')
}

export type ConfigSource = 'file' | 'defaults'

export type LoadResult = {
  settings: Settings
  source: ConfigSource
  warnings: string[]
  path: string
}

export function loadSettings(path: string = configPath()): LoadResult {
  if (!existsSync(path)) {
    return { settings: { ...defaultSettings }, source: 'defaults', warnings: [], path }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return {
      settings: { ...defaultSettings },
      source: 'defaults',
      warnings: [`config: read failed: ${errMessage(err)}`],
      path,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      settings: { ...defaultSettings },
      source: 'defaults',
      warnings: [`config: invalid JSON: ${errMessage(err)}`],
      path,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      settings: { ...defaultSettings },
      source: 'defaults',
      warnings: ['config: top-level must be a JSON object'],
      path,
    }
  }
  const warnings: string[] = []
  const merged = mergeSettings(parsed as Record<string, unknown>, warnings)
  return { settings: merged, source: 'file', warnings, path }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Merge user-supplied values into a fresh defaults object. Each key is
// validated by type and (where relevant) by enum membership; bad values
// produce a warning and fall through to the default.
export function mergeSettings(
  input: Record<string, unknown>,
  warnings: string[],
): Settings {
  const out: Settings = { ...defaultSettings }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in defaultSettings)) {
      warnings.push(`config: unknown key "${key}" ignored`)
      continue
    }
    const k = key as keyof Settings
    if (!validateAndAssign(out, k, value, warnings)) {
      // warning was pushed; default stays in place
      continue
    }
  }
  return out
}

function validateAndAssign(
  out: Settings,
  key: keyof Settings,
  value: unknown,
  warnings: string[],
): boolean {
  switch (key) {
    case 'theme':
      if (value === 'dark' || value === 'light') {
        out.theme = value
        return true
      }
      warnings.push(`config: "theme" must be "dark" or "light"`)
      return false
    case 'chatListDensity':
      if (value === 'cozy' || value === 'compact') {
        out.chatListDensity = value
        return true
      }
      warnings.push(`config: "chatListDensity" must be "cozy" or "compact"`)
      return false
    case 'chatListShortNames':
    case 'showPresenceInList':
    case 'showTimestampsInPane':
      if (typeof value === 'boolean') {
        out[key] = value
        return true
      }
      warnings.push(`config: "${key}" must be a boolean`)
      return false
    case 'windowHeight':
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        out.windowHeight = value
        return true
      }
      warnings.push(`config: "windowHeight" must be a non-negative integer (0 = full)`)
      return false
  }
}
