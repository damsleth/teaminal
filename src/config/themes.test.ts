import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadThemeFile } from './themes'

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'teaminal-themes-'))
}

describe('loadThemeFile', () => {
  test('returns source=builtin without touching disk for built-in names', () => {
    const home = tmpHome()
    const r = loadThemeFile('dark', { HOME: home })
    expect(r.source).toBe('builtin')
    expect(r.data).toBeNull()
    expect(r.warnings).toEqual([])
  })

  test('returns source=missing with a warning when the file is not present', () => {
    const home = tmpHome()
    const r = loadThemeFile('neon', { HOME: home })
    expect(r.source).toBe('missing')
    expect(r.data).toBeNull()
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toMatch(/file not found/)
  })

  test('parses a partial theme JSON and validates layout/borders/emphasis', () => {
    const home = tmpHome()
    const dir = join(home, '.config', 'teaminal', 'themes')
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'neon.json'),
      JSON.stringify({
        background: '#001100',
        selected: 'magenta',
        layout: { modalPaddingX: 5, panePaddingX: 0 },
        borders: { panel: 'double', modal: 'bold' },
        emphasis: { selectedBold: false, modalTitleBold: true },
        presence: { Available: 'greenBright', Bogus: 'red' },
        unknownKey: 'ignored',
      }),
    )

    const r = loadThemeFile('neon', { HOME: home })
    expect(r.source).toBe('file')
    expect(r.data).toBeTruthy()
    const d = r.data as Record<string, unknown>
    expect(d.background).toBe('#001100')
    expect(d.selected).toBe('magenta')
    expect(d.layout).toEqual({ modalPaddingX: 5, panePaddingX: 0 })
    expect(d.borders).toEqual({ panel: 'double', modal: 'bold' })
    expect(d.emphasis).toEqual({ selectedBold: false, modalTitleBold: true })
    expect((d.presence as Record<string, string>).Available).toBe('greenBright')
    expect((d.presence as Record<string, string>).Bogus).toBeUndefined()
    expect(d.unknownKey).toBeUndefined()
    // Two warnings: unknown top-level key + unknown presence key
    expect(r.warnings.some((w) => /unknownKey/.test(w))).toBe(true)
    expect(r.warnings.some((w) => /Bogus/.test(w))).toBe(true)
  })

  test('rejects invalid border style with a warning', () => {
    const home = tmpHome()
    const dir = join(home, '.config', 'teaminal', 'themes')
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ borders: { panel: 'wobble' } }))

    const r = loadThemeFile('bad', { HOME: home })
    expect(r.source).toBe('file')
    expect(r.warnings.some((w) => /borders\.panel.*one of/.test(w))).toBe(true)
    // The empty borders object is dropped (no valid keys → not assigned).
    expect((r.data as Record<string, unknown>).borders).toBeUndefined()
  })

  test('returns missing with a warning on invalid JSON', () => {
    const home = tmpHome()
    const dir = join(home, '.config', 'teaminal', 'themes')
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.json'), '{ not json')

    const r = loadThemeFile('broken', { HOME: home })
    expect(r.source).toBe('missing')
    expect(r.warnings[0]).toMatch(/invalid JSON/)
  })

  test('accepts selectedRowBackground as a hex color or null', () => {
    const home = tmpHome()
    const dir = join(home, '.config', 'teaminal', 'themes')
    require('node:fs').mkdirSync(dir, { recursive: true })

    // Valid hex value
    writeFileSync(join(dir, 'rowbg-hex.json'), JSON.stringify({ selectedRowBackground: '#262626' }))
    const r1 = loadThemeFile('rowbg-hex', { HOME: home })
    expect(r1.source).toBe('file')
    expect(r1.warnings).toEqual([])
    expect((r1.data as Record<string, unknown>).selectedRowBackground).toBe('#262626')

    // null (disables the highlight)
    writeFileSync(join(dir, 'rowbg-null.json'), JSON.stringify({ selectedRowBackground: null }))
    const r2 = loadThemeFile('rowbg-null', { HOME: home })
    expect(r2.source).toBe('file')
    expect(r2.warnings).toEqual([])
    expect((r2.data as Record<string, unknown>).selectedRowBackground).toBeNull()

    // Invalid value warns and ignores
    writeFileSync(
      join(dir, 'rowbg-bad.json'),
      JSON.stringify({ selectedRowBackground: 'not-a-color' }),
    )
    const r3 = loadThemeFile('rowbg-bad', { HOME: home })
    expect(r3.source).toBe('file')
    expect(r3.warnings.some((w) => /selectedRowBackground/.test(w))).toBe(true)
    expect((r3.data as Record<string, unknown>).selectedRowBackground).toBeUndefined()
  })
})
