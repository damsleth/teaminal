import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getConfigPath,
  loadConfig,
  loadSettings,
  mergeSettings,
  saveConfig,
  updateConfig,
} from './index'
import { defaultSettings } from '../state/store'

let tmpDir: string
let cfgPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'teaminal-cfg-'))
  cfgPath = join(tmpDir, 'config.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('getConfigPath', () => {
  test('honors XDG_CONFIG_HOME', () => {
    expect(getConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg', HOME: '/home/me' })).toBe(
      '/tmp/xdg/teaminal/config.json',
    )
  })

  test('falls back to HOME/.config', () => {
    expect(getConfigPath({ HOME: '/home/me' })).toBe('/home/me/.config/teaminal/config.json')
  })
})

describe('loadSettings', () => {
  test('returns defaults when the file is missing', () => {
    const r = loadSettings(join(tmpDir, 'no-such.json'))
    expect(r.source).toBe('defaults')
    expect(r.settings).toEqual(defaultSettings)
    expect(r.warnings).toEqual([])
  })

  test('parses a valid file and overrides defaults', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        theme: 'light',
        chatListShortNames: true,
        showReactions: 'all',
        messageFocusIndicatorChar: '|',
        messageFocusIndicatorColor: '#ff00aa',
        themeOverrides: {
          timestamp: '#abcdef',
          presence: { Available: 'greenBright' },
        },
      }),
    )
    const r = loadSettings(cfgPath)
    expect(r.source).toBe('file')
    expect(r.settings.theme).toBe('light')
    expect(r.settings.chatListShortNames).toBe(true)
    expect(r.settings.showReactions).toBe('all')
    expect(r.settings.messageFocusIndicatorChar).toBe('|')
    expect(r.settings.messageFocusIndicatorColor).toBe('#ff00aa')
    expect(r.settings.themeOverrides.timestamp).toBe('#abcdef')
    expect(r.settings.themeOverrides.presence?.Available).toBe('greenBright')
    // Untouched keys keep their default
    expect(r.settings.chatListDensity).toBe(defaultSettings.chatListDensity)
    expect(r.warnings).toEqual([])
  })

  test('warns on invalid JSON and falls back to defaults', () => {
    writeFileSync(cfgPath, '{ this is not json')
    const r = loadSettings(cfgPath)
    expect(r.source).toBe('defaults')
    expect(r.settings).toEqual(defaultSettings)
    expect(r.warnings.some((w) => /invalid JSON/.test(w))).toBe(true)
  })

  test('warns on non-object top-level', () => {
    writeFileSync(cfgPath, JSON.stringify(['theme', 'dark']))
    const r = loadSettings(cfgPath)
    expect(r.source).toBe('defaults')
    expect(r.warnings.some((w) => /must be a JSON object/.test(w))).toBe(true)
  })
})

describe('loadConfig', () => {
  test('returns the same validated shape as loadSettings', async () => {
    writeFileSync(cfgPath, JSON.stringify({ theme: 'light' }))
    const r = await loadConfig(cfgPath)
    expect(r.settings.theme).toBe('light')
    expect(r.config.theme).toBe('light')
  })
})

describe('mergeSettings', () => {
  test('warns and skips unknown keys', () => {
    const w: string[] = []
    const out = mergeSettings({ unknownKey: 'x' }, w)
    expect(out).toEqual(defaultSettings)
    expect(w.some((m) => /unknown key "unknownKey"/.test(m))).toBe(true)
  })

  test('rejects wrong-shape values for enums', () => {
    const w: string[] = []
    const out = mergeSettings({ theme: 'neon', showReactions: 'selected' }, w)
    expect(out.theme).toBe(defaultSettings.theme)
    expect(out.showReactions).toBe(defaultSettings.showReactions)
    expect(w.some((m) => /"theme" must be/.test(m))).toBe(true)
    expect(w.some((m) => /"showReactions" must be/.test(m))).toBe(true)
  })

  test('rejects non-boolean for boolean keys', () => {
    const w: string[] = []
    const out = mergeSettings({ chatListShortNames: 'yes' }, w)
    expect(out.chatListShortNames).toBe(defaultSettings.chatListShortNames)
    expect(w.some((m) => /"chatListShortNames" must be a boolean/.test(m))).toBe(true)
  })

  test('rejects negative or non-integer windowHeight', () => {
    const w: string[] = []
    expect(mergeSettings({ windowHeight: -3 }, w).windowHeight).toBe(0)
    expect(mergeSettings({ windowHeight: 1.5 }, w).windowHeight).toBe(0)
    expect(w.length).toBe(2)
  })

  test('accepts zero and positive integers for windowHeight', () => {
    const w: string[] = []
    expect(mergeSettings({ windowHeight: 0 }, w).windowHeight).toBe(0)
    expect(mergeSettings({ windowHeight: 30 }, w).windowHeight).toBe(30)
    expect(w).toEqual([])
  })

  test('validates planned message focus indicator fields', () => {
    const w: string[] = []
    const out = mergeSettings(
      {
        messageFocusIndicatorEnabled: false,
        messageFocusIndicatorChar: '|',
        messageFocusIndicatorColor: 'cyanBright',
        messageFocusBackgroundColor: null,
      },
      w,
    )
    expect(out.messageFocusIndicatorEnabled).toBe(false)
    expect(out.messageFocusIndicatorChar).toBe('|')
    expect(out.messageFocusIndicatorColor).toBe('cyanBright')
    expect(out.messageFocusBackgroundColor).toBeNull()
    expect(w).toEqual([])
  })

  test('validates managed account config', () => {
    const w: string[] = []
    const out = mergeSettings(
      { accounts: ['work', 'work', ' personal ', ''], activeAccount: 'work' },
      w,
    )
    expect(out.accounts).toEqual(['work', 'personal'])
    expect(out.activeAccount).toBe('work')
    expect(w).toEqual([])
  })

  test('rejects invalid message focus indicator fields', () => {
    const w: string[] = []
    const out = mergeSettings(
      {
        messageFocusIndicatorChar: '>>',
        messageFocusIndicatorColor: 'rgba(0,0,0,0.3)',
      },
      w,
    )
    expect(out.messageFocusIndicatorChar).toBe(defaultSettings.messageFocusIndicatorChar)
    expect(out.messageFocusIndicatorColor).toBeNull()
    expect(w.some((m) => /messageFocusIndicatorChar/.test(m))).toBe(true)
    expect(w.some((m) => /messageFocusIndicatorColor/.test(m))).toBe(true)
  })

  test('validates theme override keys and colors', () => {
    const w: string[] = []
    const out = mergeSettings(
      {
        themeOverrides: {
          selected: '#0af',
          unknown: 'red',
          timestamp: 'not-a-color',
          presence: {
            Available: 'green',
            UnknownPresence: 'blue',
            Busy: 'invalid',
          },
        },
      },
      w,
    )
    expect(out.themeOverrides.selected).toBe('#0af')
    expect(out.themeOverrides.timestamp).toBeUndefined()
    expect(out.themeOverrides.presence?.Available).toBe('green')
    expect(out.themeOverrides.presence?.Busy).toBeUndefined()
    expect(w.some((m) => /unknown themeOverrides key "unknown"/.test(m))).toBe(true)
    expect(w.some((m) => /themeOverrides.timestamp/.test(m))).toBe(true)
    expect(w.some((m) => /UnknownPresence/.test(m))).toBe(true)
    expect(w.some((m) => /themeOverrides.presence.Busy/.test(m))).toBe(true)
  })
})

describe('saveConfig/updateConfig', () => {
  test('creates the config directory and writes atomically to config.json', async () => {
    const nestedPath = join(tmpDir, 'xdg', 'teaminal', 'config.json')
    await saveConfig({ theme: 'light', windowHeight: 30 }, nestedPath)

    expect(existsSync(nestedPath)).toBe(true)
    const saved = JSON.parse(readFileSync(nestedPath, 'utf8'))
    expect(saved.theme).toBe('light')
    expect(saved.windowHeight).toBe(30)
    expect(readdirSync(join(tmpDir, 'xdg', 'teaminal')).sort()).toEqual(['config.json'])
  })

  test('updateConfig patches existing valid settings and persists the result', async () => {
    writeFileSync(cfgPath, JSON.stringify({ theme: 'light', chatListShortNames: true }))
    const next = await updateConfig({ showPresenceInList: false }, cfgPath)

    expect(next.theme).toBe('light')
    expect(next.chatListShortNames).toBe(true)
    expect(next.showPresenceInList).toBe(false)

    const loaded = loadSettings(cfgPath)
    expect(loaded.settings.showPresenceInList).toBe(false)
    expect(loaded.settings.theme).toBe('light')
  })

  test('updateConfig deep-patches theme overrides', async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        themeOverrides: {
          selected: 'cyan',
          presence: { Available: 'green' },
        },
      }),
    )

    const next = await updateConfig(
      { themeOverrides: { timestamp: 'gray', presence: { Busy: 'red' } } },
      cfgPath,
    )

    expect(next.themeOverrides?.selected).toBe('cyan')
    expect(next.themeOverrides?.timestamp).toBe('gray')
    expect(next.themeOverrides?.presence?.Available).toBe('green')
    expect(next.themeOverrides?.presence?.Busy).toBe('red')
  })
})
