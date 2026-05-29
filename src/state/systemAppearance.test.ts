import { describe, expect, test } from 'bun:test'
import { detectSystemAppearance, startSystemAppearanceDriver } from './systemAppearance'
import { createAppStore } from './store'

describe('detectSystemAppearance', () => {
  test('reports dark when AppleInterfaceStyle is "Dark"', () => {
    expect(detectSystemAppearance({ platform: 'darwin', read: () => 'Dark\n' })).toBe('dark')
  })

  test('reports light when the read throws (key absent = light mode)', () => {
    expect(
      detectSystemAppearance({
        platform: 'darwin',
        read: () => {
          throw new Error('does not exist')
        },
      }),
    ).toBe('light')
  })

  test('reports light for any non-"Dark" value', () => {
    expect(detectSystemAppearance({ platform: 'darwin', read: () => 'Light' })).toBe('light')
  })

  test('defaults to dark on non-darwin platforms', () => {
    expect(
      detectSystemAppearance({
        platform: 'linux',
        read: () => {
          throw new Error('should not be called')
        },
      }),
    ).toBe('dark')
  })
})

describe('startSystemAppearanceDriver', () => {
  test('applies the initial appearance synchronously', () => {
    const store = createAppStore()
    const driver = startSystemAppearanceDriver(store, { detect: () => 'light' })
    expect(store.get().systemAppearance).toBe('light')
    driver.stop()
  })

  test('only writes when the appearance changes', () => {
    const store = createAppStore()
    let writes = 0
    const unsub = store.subscribe(() => {
      writes++
    })
    const driver = startSystemAppearanceDriver(store, { detect: () => 'dark', intervalMs: 60_000 })
    // initial apply: store already defaults to 'dark', so no write
    expect(store.get().systemAppearance).toBe('dark')
    expect(writes).toBe(0)
    driver.stop()
    unsub()
  })
})
