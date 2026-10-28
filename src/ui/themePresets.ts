// Theme presets: save / save as / load / delete for theme files in
// ~/.config/teaminal/themes/<name>.json.
//
// Model: settings.themeOverrides are the unsaved edits (the theme editor's
// dots). Saving folds the ones that apply to the active base into the
// preset file and clears them, so the look doesn't change. Loading only
// switches the theme: unsaved edits stay on top, as they do on any theme
// switch.

import { replaceThemeOverrides, updateSettings } from '../config'
import {
  deleteThemePreset,
  isBuiltinThemeName,
  isValidPresetName,
  listThemePresets,
  loadThemeFile,
  writeThemePreset,
} from '../config/themes'
import { warn } from '../log'
import type { AppState, Store } from '../state/store'
import { activeCustomThemeData } from './StoreContext'
import { bakeTheme, remainingOverrides, resolveBaseName, type BuiltinThemeName } from './theme'

export const BUILTIN_THEME_CHOICES = ['auto', 'dark', 'light'] as const

// Everything the presets list offers: built-ins first, then saved presets.
export function themeChoices(): { name: string; builtin: boolean }[] {
  return [
    ...BUILTIN_THEME_CHOICES.map((name) => ({ name, builtin: true })),
    ...listThemePresets().map((name) => ({ name, builtin: false })),
  ]
}

function activeBase(s: AppState): BuiltinThemeName {
  const custom = activeCustomThemeData(s.settings.theme, s.customTheme)
  return resolveBaseName(s.settings.theme, s.systemAppearance, custom?.base)
}

// The active theme is a saved preset (not a built-in), so plain Save can
// write back to it.
export function activePresetName(s: AppState): string | null {
  const name = s.settings.theme
  return isBuiltinThemeName(name) ? null : name
}

export async function loadThemePreset(store: Store<AppState>, name: string): Promise<void> {
  if (isBuiltinThemeName(name)) {
    store.set((s) => ({ settings: { ...s.settings, theme: name } }))
  } else {
    const loaded = loadThemeFile(name)
    for (const w of loaded.warnings) warn(w)
    if (!loaded.data) return
    store.set((s) => ({
      settings: { ...s.settings, theme: name },
      customTheme: { name, data: loaded.data! },
    }))
  }
  await updateSettings({ theme: name }).catch((err) =>
    warn('config: failed to persist theme:', errMessage(err)),
  )
}

// Write the current look to `name` and make it the active theme. Returns
// an error message for the UI, or null on success.
export async function saveThemePresetAs(
  store: Store<AppState>,
  name: string,
): Promise<string | null> {
  const trimmed = name.trim()
  if (!isValidPresetName(trimmed)) {
    return isBuiltinThemeName(trimmed)
      ? `"${trimmed}" is a built-in theme`
      : 'use letters, digits, space, _ . - (max 41)'
  }
  const s = store.get()
  const base = activeBase(s)
  const custom = activeCustomThemeData(s.settings.theme, s.customTheme)
  const data = bakeTheme(custom, s.settings.themeOverrides, base)
  try {
    writeThemePreset(trimmed, data as Record<string, unknown>)
  } catch (err) {
    return `save failed: ${errMessage(err)}`
  }
  const rest = remainingOverrides(s.settings.themeOverrides, base)
  store.set((st) => ({
    settings: { ...st.settings, theme: trimmed, themeOverrides: rest },
    customTheme: { name: trimmed, data: data as Record<string, unknown> },
  }))
  try {
    // Sequential: each call reads config.json and writes it back.
    await updateSettings({ theme: trimmed })
    await replaceThemeOverrides(rest)
  } catch (err) {
    warn('config: failed to persist saved theme:', errMessage(err))
  }
  return null
}

// Delete a saved preset. If it was active, fall back to its base palette.
export async function deleteThemePresetByName(store: Store<AppState>, name: string): Promise<void> {
  if (isBuiltinThemeName(name)) return
  const s = store.get()
  const wasActive = s.settings.theme === name
  const fallback: BuiltinThemeName = wasActive ? activeBase(s) : 'dark'
  try {
    deleteThemePreset(name)
  } catch (err) {
    warn(`theme: failed to delete "${name}":`, errMessage(err))
    return
  }
  if (wasActive) await loadThemePreset(store, fallback)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
