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
})
