import { describe, expect, test } from 'bun:test'
import { shouldShowTailPanels } from './App'

describe('shouldShowTailPanels', () => {
  test('keeps always-on tails visible when no modal is active', () => {
    expect(shouldShowTailPanels(null)).toBe(true)
  })

  test('hides always-on tails while overlay modals are active', () => {
    expect(shouldShowTailPanels({ kind: 'keybinds' })).toBe(false)
    expect(shouldShowTailPanels({ kind: 'network' })).toBe(false)
    expect(shouldShowTailPanels({ kind: 'events' })).toBe(false)
    expect(shouldShowTailPanels({ kind: 'diagnostics' })).toBe(false)
    expect(shouldShowTailPanels({ kind: 'menu', path: [], cursor: 0 })).toBe(false)
    expect(shouldShowTailPanels({ kind: 'theme-editor', cursor: 0 })).toBe(false)
    expect(shouldShowTailPanels({ kind: 'accounts', mode: 'list', cursor: 0, accounts: [] })).toBe(
      false,
    )
    expect(shouldShowTailPanels({ kind: 'activity', cursor: 0 })).toBe(false)
  })

  test('hides always-on tails while replacement modals are active', () => {
    expect(
      shouldShowTailPanels({
        kind: 'auth-expired',
        profile: null,
        message: 'expired',
        status: 'idle',
      }),
    ).toBe(false)
  })
})
