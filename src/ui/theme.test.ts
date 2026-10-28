import { describe, expect, test } from 'bun:test'
import { defaultSettings } from '../state/store'
import {
  blendAlpha,
  builtinThemes,
  getTheme,
  modalBg,
  resolveTheme,
  TERMINAL_DEFAULT,
} from './theme'

describe('getTheme', () => {
  test('returns clones of built-in themes', () => {
    const first = getTheme('dark')
    const second = getTheme('dark')
    first.presence.Available = 'red'
    expect(second.presence.Available).toBe(builtinThemes.dark.presence.Available)
  })
})

describe('resolveTheme', () => {
  test('deep-merges flat and presence overrides onto the selected built-in theme', () => {
    const theme = resolveTheme({
      ...defaultSettings,
      theme: 'light',
      themeOverrides: {
        selected: '#00ffaa',
        presence: {
          Available: 'greenBright',
        },
      },
    })

    expect(theme.text).toBe(builtinThemes.light.text)
    expect(theme.selected).toBe('#00ffaa')
    expect(theme.presence.Available).toBe('greenBright')
    expect(theme.presence.Busy).toBe(builtinThemes.light.presence.Busy)
  })

  test('explicit message focus color settings win over theme overrides', () => {
    const theme = resolveTheme({
      ...defaultSettings,
      themeOverrides: {
        messageFocusIndicator: 'yellow',
        messageFocusBackground: 'black',
      },
      messageFocusIndicatorColor: 'cyanBright',
      messageFocusBackgroundColor: '#111111',
    })

    expect(theme.messageFocusIndicator).toBe('cyanBright')
    expect(theme.messageFocusBackground).toBe('#111111')
  })

  test('null message focus color settings preserve resolved theme defaults', () => {
    const theme = resolveTheme({
      ...defaultSettings,
      themeOverrides: {
        messageFocusIndicator: 'yellow',
        messageFocusBackground: null,
      },
      messageFocusIndicatorColor: null,
      messageFocusBackgroundColor: null,
    })

    expect(theme.messageFocusIndicator).toBe('yellow')
    expect(theme.messageFocusBackground).toBeNull()
  })

  test('auto theme resolves to the dark base under a dark system appearance', () => {
    const theme = resolveTheme({ ...defaultSettings, theme: 'auto' }, null, 'dark')
    expect(theme.modalBackground).toBe(builtinThemes.dark.modalBackground)
  })

  test('auto theme resolves to the light base under a light system appearance', () => {
    const theme = resolveTheme({ ...defaultSettings, theme: 'auto' }, null, 'light')
    expect(theme.modalBackground).toBe(builtinThemes.light.modalBackground)
  })

  test('explicit theme ignores system appearance', () => {
    const theme = resolveTheme({ ...defaultSettings, theme: 'dark' }, null, 'light')
    expect(theme.modalBackground).toBe(builtinThemes.dark.modalBackground)
  })

  test('layered partial theme is applied between built-in base and overrides', () => {
    const theme = resolveTheme(
      {
        ...defaultSettings,
        theme: 'dark',
        themeOverrides: {
          layout: { modalPaddingY: 3 },
        },
      },
      {
        layout: { modalPaddingX: 7, modalPaddingY: 5 },
        borders: { modal: 'double' },
        emphasis: { selectedBold: false },
        selected: '#abcdef',
      },
    )

    // Custom theme wins over built-in base
    expect(theme.layout.modalPaddingX).toBe(7)
    expect(theme.borders.modal).toBe('double')
    expect(theme.emphasis.selectedBold).toBe(false)
    expect(theme.selected).toBe('#abcdef')
    // themeOverrides wins over the custom theme
    expect(theme.layout.modalPaddingY).toBe(3)
    // Untouched keys fall back to the built-in base
    expect(theme.layout.senderIndent).toBe(builtinThemes.dark.layout.senderIndent)
    expect(theme.borders.panel).toBe('round')
    expect(theme.emphasis.modalTitleBold).toBe(true)
  })

  test('unknown theme name falls back to dark base', () => {
    const theme = resolveTheme({ ...defaultSettings, theme: 'does-not-exist' })
    expect(theme.modalBackground).toBe(builtinThemes.dark.modalBackground)
    expect(theme.layout).toEqual(builtinThemes.dark.layout)
  })

  test('selectedRowBackground is set on both built-in themes', () => {
    const dark = resolveTheme({ ...defaultSettings, theme: 'dark' })
    expect(typeof dark.selectedRowBackground).toBe('string')
    expect(dark.selectedRowBackground).not.toBeNull()

    const light = resolveTheme({ ...defaultSettings, theme: 'light' })
    expect(typeof light.selectedRowBackground).toBe('string')
    expect(light.selectedRowBackground).not.toBeNull()

    // The two built-in values must differ (dark/light distinction)
    expect(dark.selectedRowBackground).not.toBe(light.selectedRowBackground)
  })

  test('selectedRowBackground themeOverrides value overrides the built-in', () => {
    const theme = resolveTheme({
      ...defaultSettings,
      theme: 'dark',
      themeOverrides: { selectedRowBackground: '#333333' },
    })
    expect(theme.selectedRowBackground).toBe('#333333')
  })

  test('selectedRowBackground themeOverrides null overrides to null', () => {
    const theme = resolveTheme({
      ...defaultSettings,
      theme: 'dark',
      themeOverrides: { selectedRowBackground: null },
    })
    expect(theme.selectedRowBackground).toBeNull()
  })

  test('selectedRowBackground from a partial custom theme is merged correctly', () => {
    const theme = resolveTheme(
      { ...defaultSettings, theme: 'dark' },
      { selectedRowBackground: '#1a1a1a' },
    )
    expect(theme.selectedRowBackground).toBe('#1a1a1a')
  })
})

describe('alpha colors', () => {
  test('blendAlpha mixes #rrggbbaa / #rgba onto the background', () => {
    expect(blendAlpha('#ffffff80', 'black')).toBe('#808080')
    expect(blendAlpha('#0000ff80', '#ffffff')).toBe('#7f7fff')
    expect(blendAlpha('#f008', '#000000')).toBe('#880000')
    expect(blendAlpha('#123456', 'black')).toBe('#123456')
    expect(blendAlpha('red', 'black')).toBe('red')
  })

  test('resolveTheme flattens alpha tokens and keeps the raw value for the editor', () => {
    const theme = resolveTheme({
      ...defaultSettings,
      theme: 'light',
      themeOverrides: { light: { selfMessageBackground: '#0000ff33' } },
    })
    expect(theme.selfMessageBackground).toBe('#ccccff')
    expect(theme.rawColors).toEqual({ selfMessageBackground: '#0000ff33' })
  })
})

describe('modalBg', () => {
  test('falls back modal -> app -> an opaque terminal-default fill', () => {
    const dark = builtinThemes.dark
    expect(modalBg({ ...dark, modalBackground: 'blue' })).toBe('blue')
    expect(modalBg({ ...dark, modalBackground: null, appBackground: 'red' })).toBe('red')
    // Must be truthy (Ink only fills a box with a backgroundColor) and not a
    // chalk name (so the fill carries no color).
    const fill = modalBg({ ...dark, modalBackground: null, appBackground: null })
    expect(fill).toBeTruthy()
    expect(fill in (require('chalk').default as object)).toBe(false)
  })
})

describe('"none" colors', () => {
  test('none on an always-drawn color resolves to the terminal default', () => {
    const theme = resolveTheme({
      ...defaultSettings,
      theme: 'dark',
      themeOverrides: { dark: { text: null, border: null } },
    })
    expect(theme.text).toBe(TERMINAL_DEFAULT)
    expect(theme.border).toBe(TERMINAL_DEFAULT)
    // Nullable tokens keep null (their own meaning: no background etc.).
    expect(theme.selectedRowBorder).toBeNull()
  })
})
