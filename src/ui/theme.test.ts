import { describe, expect, test } from 'bun:test'
import { defaultSettings } from '../state/store'
import { builtinThemes, getTheme, resolveTheme } from './theme'

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

  test('compact and comfortable presets differ in layout but inherit dark colors', () => {
    expect(builtinThemes.compact.layout.modalPaddingX).toBe(2)
    expect(builtinThemes.comfortable.layout.modalPaddingX).toBe(4)
    expect(builtinThemes.compact.background).toBe(builtinThemes.dark.background)
    expect(builtinThemes.comfortable.borders.panel).toBe('round')
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
    expect(theme.layout.panePaddingX).toBe(builtinThemes.dark.layout.panePaddingX)
    expect(theme.borders.panel).toBe('round')
    expect(theme.emphasis.modalTitleBold).toBe(true)
  })

  test('unknown theme name falls back to dark base', () => {
    const theme = resolveTheme({ ...defaultSettings, theme: 'does-not-exist' })
    expect(theme.background).toBe(builtinThemes.dark.background)
    expect(theme.layout).toEqual(builtinThemes.dark.layout)
  })
})
