import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteThemePreset,
  isValidPresetName,
  listThemePresets,
  loadThemeFile,
  writeThemePreset,
} from '../config/themes'
import { defaultSettings, type ThemeOverrides } from '../state/store'
import { bakeTheme, remainingOverrides, resolveTheme, type PartialTheme } from './theme'

const OVERRIDES: ThemeOverrides = {
  text: '#111111',
  light: { selected: '#222222', appBackground: null },
  dark: { selected: '#999999' },
  layout: { modalPaddingX: 5 },
  borders: { modal: 'double' },
  presence: { Available: 'cyan' },
  fontSize: { timestamp: 60 },
}

describe('bakeTheme', () => {
  test('a baked preset renders exactly like the base plus its overrides', () => {
    const before = resolveTheme({ ...defaultSettings, theme: 'light', themeOverrides: OVERRIDES })
    const preset = bakeTheme(null, OVERRIDES, 'light')
    const after = resolveTheme(
      { ...defaultSettings, theme: 'mine', themeOverrides: remainingOverrides(OVERRIDES, 'light') },
      preset,
    )
    expect(after).toEqual(before)
    expect(preset.base).toBe('light')
  })

  test('re-baking a loaded preset with new edits keeps both', () => {
    const custom: PartialTheme = { base: 'dark', text: '#abcdef', layout: { senderIndent: 4 } }
    const edits: ThemeOverrides = { dark: { unread: '#ff0000' }, layout: { modalPaddingY: 2 } }
    const before = resolveTheme({ ...defaultSettings, theme: 'p', themeOverrides: edits }, custom)
    const baked = bakeTheme(custom, edits, 'dark')
    const after = resolveTheme({ ...defaultSettings, theme: 'p', themeOverrides: {} }, baked)
    expect(after).toEqual(before)
    expect(baked.layout).toEqual({ senderIndent: 4, modalPaddingY: 2 })
  })

  test('only the other base bucket is left over', () => {
    expect(remainingOverrides(OVERRIDES, 'light')).toEqual({ dark: { selected: '#999999' } })
    expect(remainingOverrides({ text: 'red' }, 'dark')).toEqual({})
  })
})

describe('theme preset files', () => {
  const env = () => ({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'teaminal-presets-')) })

  test('write, list, load (with base) and delete round-trip', () => {
    const e = env()
    writeThemePreset('My Light', { base: 'light', text: '#111111' }, e)
    writeThemePreset('alpha', { text: 'red' }, e)
    expect(listThemePresets(e)).toEqual(['alpha', 'My Light'])
    const loaded = loadThemeFile('My Light', e)
    expect(loaded.source).toBe('file')
    expect(loaded.data).toEqual({ base: 'light', text: '#111111' })
    deleteThemePreset('alpha', e)
    expect(listThemePresets(e)).toEqual(['My Light'])
  })

  test('names that are built-ins or could escape the themes dir are refused', () => {
    for (const bad of ['dark', 'light', 'auto', '../x', 'a/b', '.hidden', '', 'x.'])
      expect(isValidPresetName(bad)).toBe(false)
    expect(() => writeThemePreset('../evil', {}, env())).toThrow()
    expect(isValidPresetName('Solarized-2 v1.0')).toBe(true)
  })
})
