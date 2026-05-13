import { describe, expect, test } from 'bun:test'
import { activeCustomThemeData } from './StoreContext'

describe('activeCustomThemeData', () => {
  test('applies loaded custom data only while that custom theme is selected', () => {
    const customTheme = {
      name: 'neon',
      data: { selected: '#abcdef' },
    }

    expect(activeCustomThemeData('neon', customTheme)).toEqual({ selected: '#abcdef' })
    expect(activeCustomThemeData('dark', customTheme)).toBeNull()
  })
})
