import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, mergeSettings } from './index'
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

describe('loadSettings', () => {
  test('returns defaults when the file is missing', () => {
    const r = loadSettings(join(tmpDir, 'no-such.json'))
    expect(r.source).toBe('defaults')
    expect(r.settings).toEqual(defaultSettings)
    expect(r.warnings).toEqual([])
  })

  test('parses a valid file and overrides defaults', () => {
    writeFileSync(cfgPath, JSON.stringify({ theme: 'light', chatListShortNames: true }))
    const r = loadSettings(cfgPath)
    expect(r.source).toBe('file')
    expect(r.settings.theme).toBe('light')
    expect(r.settings.chatListShortNames).toBe(true)
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

describe('mergeSettings', () => {
  test('warns and skips unknown keys', () => {
    const w: string[] = []
    const out = mergeSettings({ unknownKey: 'x' }, w)
    expect(out).toEqual(defaultSettings)
    expect(w.some((m) => /unknown key "unknownKey"/.test(m))).toBe(true)
  })

  test('rejects wrong-shape values for enums', () => {
    const w: string[] = []
    const out = mergeSettings({ theme: 'neon' }, w)
    expect(out.theme).toBe(defaultSettings.theme)
    expect(w.some((m) => /"theme" must be/.test(m))).toBe(true)
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
})
