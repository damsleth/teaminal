import { describe, expect, test } from 'bun:test'
import { activePane, shouldShowTailPanels } from './App'

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

describe('activePane', () => {
  const chat = { kind: 'chat', chatId: 'c1' } as const
  test('follows the input zone and focus to the pane that takes keys', () => {
    expect(activePane('list', { kind: 'list' })).toBe('list')
    expect(activePane('filter', chat)).toBe('list')
    expect(activePane('list', chat)).toBe('conversation')
    expect(activePane('message-search', chat)).toBe('conversation')
    expect(activePane('composer', chat)).toBe('composer')
  })

  test('no pane is active behind a modal', () => {
    expect(activePane('menu', chat)).toBeNull()
  })
})
