import { describe, expect, test } from 'bun:test'
import {
  anyOverridden,
  applyField,
  clampNumeric,
  COLOR_PALETTE,
  cycleColor,
  cycleEnum,
  FIELDS,
  fieldValue,
  fieldWindow,
  formatFieldValue,
  isHexColor,
  isOverridden,
  moveCursor,
  nextFieldValue,
  resetAllOverrides,
  resetField,
  type ColorField,
  type EditableField,
  type EnumField,
  type FieldValue,
  type NumericField,
} from './themeEditor'
import { validateThemeOverrides } from '../config'
import { defaultSettings, type Settings, type ThemeOverrides } from '../state/store'
import { getTheme, resolveTheme } from './theme'

const baseTheme = getTheme('dark')
const baseSettings: Settings = { ...defaultSettings, themeOverrides: {} }

function withOverrides(overrides: ThemeOverrides): Settings {
  return { ...defaultSettings, themeOverrides: overrides }
}

const field = (id: string): EditableField => {
  const f = FIELDS.find((x) => x.id === id)
  if (!f) throw new Error(`no field ${id}`)
  return f
}

// A representative editable value per field, used by the round-trip /
// validator-acceptance tests.
function sampleValue(f: EditableField): FieldValue {
  switch (f.kind) {
    case 'numeric':
      return clampNumeric(f, f.min + 1)
    case 'color':
      return f.nullable ? '#abcdef' : 'magenta'
    case 'enum':
      return f.options[1] ?? f.options[0]!
    case 'boolean':
      return false
  }
}

describe('FIELDS descriptor list', () => {
  test('ids are unique', () => {
    const ids = FIELDS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('numeric bounds are well-formed', () => {
    for (const f of FIELDS) {
      if (f.kind !== 'numeric') continue
      expect(f.min).toBeLessThanOrEqual(f.max)
      expect(f.step).toBeGreaterThan(0)
    }
  })

  test('covers all four value kinds', () => {
    const kinds = new Set(FIELDS.map((f) => f.kind))
    expect(kinds).toEqual(new Set(['numeric', 'color', 'enum', 'boolean']))
  })

  test('setting-backed fields name real Settings keys', () => {
    for (const f of FIELDS) {
      if (f.group !== 'setting') continue
      expect(f.key in defaultSettings).toBe(true)
    }
  })
})

describe('clampNumeric', () => {
  const f = field('layout.panePaddingX') as NumericField // 0..6

  test('clamps below min and above max', () => {
    expect(clampNumeric(f, -3)).toBe(f.min)
    expect(clampNumeric(f, 99)).toBe(f.max)
  })

  test('rounds to an integer', () => {
    expect(clampNumeric(f, 2.7)).toBe(3)
  })

  test('NaN falls back to min', () => {
    expect(clampNumeric(f, NaN)).toBe(f.min)
  })
})

describe('cycleEnum', () => {
  const f = field('borders.panel') as EnumField

  test('cycles forward and wraps', () => {
    const first = f.options[0]!
    const second = f.options[1]!
    expect(cycleEnum(f, first, 1)).toBe(second)
    expect(cycleEnum(f, f.options[f.options.length - 1]!, 1)).toBe(first)
  })

  test('cycles backward and wraps', () => {
    expect(cycleEnum(f, f.options[0]!, -1)).toBe(f.options[f.options.length - 1]!)
  })

  test('unknown current resolves to the first option', () => {
    expect(cycleEnum(f, 'bogus', 1)).toBe(f.options[0]!)
  })
})

describe('cycleColor', () => {
  const solid = field('color.background') as ColorField
  const nullable = field('color.messageFocusBackground') as ColorField

  test('cycles through the palette', () => {
    expect(cycleColor(solid, COLOR_PALETTE[0]!, 1)).toBe(COLOR_PALETTE[1]!)
  })

  test('nullable fields include null at the front of the cycle', () => {
    // null -> first palette entry going forward
    expect(cycleColor(nullable, null, 1)).toBe(COLOR_PALETTE[0]!)
    // first palette entry -> null going backward
    expect(cycleColor(nullable, COLOR_PALETTE[0]!, -1)).toBeNull()
  })

  test('a custom hex not in the palette jumps to an end', () => {
    expect(cycleColor(solid, '#123456', 1)).toBe(COLOR_PALETTE[0]!)
    expect(cycleColor(solid, '#123456', -1)).toBe(COLOR_PALETTE[COLOR_PALETTE.length - 1]!)
  })
})

describe('nextFieldValue', () => {
  test('numeric steps and clamps', () => {
    const f = field('layout.modalPaddingY') as NumericField // 0..4
    expect(nextFieldValue(f, 0, 1)).toBe(1)
    expect(nextFieldValue(f, 4, 1)).toBe(4) // clamped at max
    expect(nextFieldValue(f, 0, -1)).toBe(0) // clamped at min
  })

  test('boolean toggles regardless of direction', () => {
    const f = field('emphasis.selectedBold')
    expect(nextFieldValue(f, true, 1)).toBe(false)
    expect(nextFieldValue(f, false, -1)).toBe(true)
  })

  test('enum cycles', () => {
    const f = field('setting.inlineImages') as EnumField
    expect(nextFieldValue(f, 'auto', 1)).toBe('off')
    expect(nextFieldValue(f, 'off', 1)).toBe('auto')
  })
})

describe('fieldValue', () => {
  test('reads the resolved theme for theme-backed fields', () => {
    expect(fieldValue(field('color.background'), baseTheme, baseSettings)).toBe(
      baseTheme.background,
    )
    expect(fieldValue(field('layout.panePaddingX'), baseTheme, baseSettings)).toBe(
      baseTheme.layout.panePaddingX,
    )
    expect(fieldValue(field('borders.panel'), baseTheme, baseSettings)).toBe(
      baseTheme.borders.panel,
    )
  })

  test('reads Settings for setting-backed fields', () => {
    expect(fieldValue(field('setting.inlineImageMaxRows'), baseTheme, baseSettings)).toBe(
      defaultSettings.inlineImageMaxRows,
    )
  })
})

describe('isOverridden', () => {
  test('false for every field on a clean settings object', () => {
    for (const f of FIELDS) expect(isOverridden(f, baseSettings)).toBe(false)
  })

  test('true once a color override is present', () => {
    const s = withOverrides({ background: 'magenta' })
    expect(isOverridden(field('color.background'), s)).toBe(true)
    expect(isOverridden(field('color.text'), s)).toBe(false)
  })

  test('true for nested layout override', () => {
    const s = withOverrides({ layout: { panePaddingX: 3 } })
    expect(isOverridden(field('layout.panePaddingX'), s)).toBe(true)
    expect(isOverridden(field('layout.modalPaddingX'), s)).toBe(false)
  })

  test('setting fields compare against the built-in default', () => {
    expect(isOverridden(field('setting.inlineImageMaxRows'), baseSettings)).toBe(false)
    const s: Settings = { ...defaultSettings, inlineImageMaxRows: 20 }
    expect(isOverridden(field('setting.inlineImageMaxRows'), s)).toBe(true)
  })
})

describe('applyField', () => {
  test('color field produces a themeOverrides patch', () => {
    const patch = applyField(baseSettings, field('color.selected'), 'magenta')
    expect(patch.kind).toBe('overrides')
    if (patch.kind !== 'overrides') throw new Error('expected overrides')
    expect(patch.overrides.selected).toBe('magenta')
  })

  test('layout field nests under layout', () => {
    const patch = applyField(baseSettings, field('layout.modalPaddingX'), 5)
    if (patch.kind !== 'overrides') throw new Error('expected overrides')
    expect(patch.overrides.layout?.modalPaddingX).toBe(5)
  })

  test('setting field produces a settings patch, not an override', () => {
    const patch = applyField(baseSettings, field('setting.inlineImageMaxRows'), 12)
    expect(patch.kind).toBe('setting')
    if (patch.kind !== 'setting') throw new Error('expected setting')
    expect(patch.patch).toEqual({ inlineImageMaxRows: 12 })
  })

  test('preserves sibling overrides', () => {
    const s = withOverrides({ background: 'red', layout: { panePaddingX: 2 } })
    const patch = applyField(s, field('color.text'), 'white')
    if (patch.kind !== 'overrides') throw new Error('expected overrides')
    expect(patch.overrides.background).toBe('red')
    expect(patch.overrides.text).toBe('white')
    expect(patch.overrides.layout?.panePaddingX).toBe(2)
  })
})

describe('resetField', () => {
  test('removes a flat color override', () => {
    const s = withOverrides({ background: 'red', text: 'white' })
    const patch = resetField(s, field('color.background'))
    if (patch.kind !== 'overrides') throw new Error('expected overrides')
    expect('background' in patch.overrides).toBe(false)
    expect(patch.overrides.text).toBe('white')
  })

  test('removes a nested override and prunes the empty sub-object', () => {
    const s = withOverrides({ layout: { panePaddingX: 3 } })
    const patch = resetField(s, field('layout.panePaddingX'))
    if (patch.kind !== 'overrides') throw new Error('expected overrides')
    expect(patch.overrides.layout).toBeUndefined()
  })

  test('keeps sibling keys inside a sub-object', () => {
    const s = withOverrides({ layout: { panePaddingX: 3, modalPaddingX: 5 } })
    const patch = resetField(s, field('layout.panePaddingX'))
    if (patch.kind !== 'overrides') throw new Error('expected overrides')
    expect(patch.overrides.layout).toEqual({ modalPaddingX: 5 })
  })

  test('setting field resets to the built-in default', () => {
    const s: Settings = { ...defaultSettings, inlineImageMaxRows: 30 }
    const patch = resetField(s, field('setting.inlineImageMaxRows'))
    if (patch.kind !== 'setting') throw new Error('expected setting')
    expect(patch.patch).toEqual({ inlineImageMaxRows: defaultSettings.inlineImageMaxRows })
  })
})

describe('resetAllOverrides', () => {
  test('clears every override', () => {
    const patch = resetAllOverrides()
    if (patch.kind !== 'overrides') throw new Error('expected overrides')
    expect(patch.overrides).toEqual({})
  })
})

describe('anyOverridden', () => {
  test('false on a clean settings object', () => {
    expect(anyOverridden(baseSettings)).toBe(false)
  })

  test('ignores setting-backed differences (only theme overrides count)', () => {
    expect(anyOverridden({ ...defaultSettings, inlineImageMaxRows: 42 })).toBe(false)
  })

  test('true once a theme override exists', () => {
    expect(anyOverridden(withOverrides({ selected: 'magenta' }))).toBe(true)
  })
})

describe('editor output validates without warnings', () => {
  test('every theme-backed field round-trips through validateThemeOverrides', () => {
    let overrides: ThemeOverrides = {}
    for (const f of FIELDS) {
      if (f.group === 'setting') continue
      const patch = applyField(withOverrides(overrides), f, sampleValue(f))
      if (patch.kind !== 'overrides') throw new Error('expected overrides')
      overrides = patch.overrides
    }
    const warnings: string[] = []
    const validated = validateThemeOverrides(overrides, warnings)
    expect(warnings).toEqual([])
    expect(validated).toEqual(overrides)
  })

  test('an applied override is reflected in the resolved theme', () => {
    const patch = applyField(baseSettings, field('color.background'), '#102030')
    if (patch.kind !== 'overrides') throw new Error('expected overrides')
    const resolved = resolveTheme(withOverrides(patch.overrides), null, 'dark')
    expect(resolved.background).toBe('#102030')
  })

  test('a cleared nullable color resolves to null', () => {
    const patch = applyField(baseSettings, field('color.selectedRowBackground'), null)
    if (patch.kind !== 'overrides') throw new Error('expected overrides')
    const resolved = resolveTheme(withOverrides(patch.overrides), null, 'dark')
    expect(resolved.selectedRowBackground).toBeNull()
  })
})

describe('fieldWindow', () => {
  test('returns the full range when everything fits', () => {
    expect(fieldWindow(10, 3, 20)).toEqual({ start: 0, end: 10 })
  })

  test('centers the cursor within the capacity', () => {
    expect(fieldWindow(40, 20, 10)).toEqual({ start: 15, end: 25 })
  })

  test('clamps to the start', () => {
    expect(fieldWindow(40, 0, 10)).toEqual({ start: 0, end: 10 })
  })

  test('clamps to the end', () => {
    expect(fieldWindow(40, 39, 10)).toEqual({ start: 30, end: 40 })
  })
})

describe('moveCursor', () => {
  test('wraps forward and backward', () => {
    expect(moveCursor(0, -1, 5)).toBe(4)
    expect(moveCursor(4, 1, 5)).toBe(0)
    expect(moveCursor(2, 1, 5)).toBe(3)
  })
})

describe('formatFieldValue / isHexColor', () => {
  test('formats null, booleans and primitives', () => {
    expect(formatFieldValue(null)).toBe('none')
    expect(formatFieldValue(true)).toBe('on')
    expect(formatFieldValue(false)).toBe('off')
    expect(formatFieldValue(3)).toBe('3')
    expect(formatFieldValue('round')).toBe('round')
  })

  test('isHexColor accepts #rgb and #rrggbb only', () => {
    expect(isHexColor('#abc')).toBe(true)
    expect(isHexColor('#aabbcc')).toBe(true)
    expect(isHexColor('#abcd')).toBe(false)
    expect(isHexColor('magenta')).toBe(false)
    expect(isHexColor('#')).toBe(false)
  })
})
