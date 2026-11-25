import { describe, expect, test } from 'bun:test'
import { Box, renderToString } from 'ink'
import { createAppStore } from '../state/store'
import { openAccount } from '../state/accountStore'
import { formatAccountBadge, HeaderBar } from './HeaderBar'
import { StoreProvider } from './StoreContext'
import { SessionProvider, type SessionApi } from './SessionContext'
import { accountRef } from '../account'
import { createGraphClient } from '../graph/client'

const session: SessionApi = {
  getActiveProfile: () => null,
  switchAccount: async () => {},
  retryRealtime: () => {},
  reconcile: async () => {},
  setForeground: () => {},
  retry: async () => {},
  running: () => [],
  clientFor: () => {
    throw new Error('unused')
  },
  client: () =>
    createGraphClient({ account: accountRef(null), audience: 'graph', fallback: false }),
}

// The bar sits in a bordered row box (App.tsx); centering must use its width.
const render = (headerBarCentered: boolean) => {
  const store = createAppStore()
  store.set({ settings: { ...store.get().settings, headerBarCentered } })
  return renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <Box borderStyle="round" paddingX={1}>
          <HeaderBar />
        </Box>
      </SessionProvider>
    </StoreProvider>,
    { columns: 100 },
  ).replace(/\x1b\[[0-9;]*m/g, '')
}

test('headerBarCentered centers the header text', () => {
  const indent = (out: string) => out.split('\n')[1]!.slice(1).search(/\S/)
  expect(indent(render(false))).toBeLessThan(4)
  expect(indent(render(true))).toBeGreaterThan(10)
})

test('formatAccountBadge collapses what does not fit into +N', () => {
  const entries = [
    { label: 'beta', mark: '3' },
    { label: 'gamma', mark: '!' },
    { label: 'delta', mark: '1' },
  ]
  expect(formatAccountBadge(entries, 40)).toBe('beta 3 · gamma ! · delta 1')
  expect(formatAccountBadge(entries, 20)).toBe('beta 3 · +2')
  expect(formatAccountBadge(entries, 3)).toBe('+3')
  expect(formatAccountBadge([], 40)).toBe('')
})

describe('background account badge', () => {
  const unread = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`c${i}`, { unreadCount: 1, mentionCount: 0 }]),
    )
  const renderAccounts = (columns: number, background: boolean) => {
    const store = createAppStore()
    store.set((s) => ({
      settings: { ...s.settings, accounts: ['alpha', 'beta', 'gamma', 'delta'] },
    }))
    openAccount(store, accountRef('alpha'), { foreground: true }).set({
      unreadByChatId: unread(5),
    })
    if (background) {
      // Opened out of order: the badge follows the configured order.
      openAccount(store, accountRef('gamma'), { foreground: false }).set({ conn: 'authError' })
      openAccount(store, accountRef('delta'), { foreground: false })
      openAccount(store, accountRef('beta'), { foreground: false }).set({
        unreadByChatId: unread(2),
        unreadMentionCount: 1,
      })
    }
    return renderToString(
      <StoreProvider store={store}>
        <SessionProvider api={session}>
          <HeaderBar columns={columns} />
        </SessionProvider>
      </StoreProvider>,
      { columns },
    ).replace(/\x1b\[[0-9;]*m/g, '')
  }

  // Two or more open accounts are the unified sidebar (M2 F.3), whose account
  // header rows carry these counts: the badge is not shown.
  test('hidden in the unified sidebar', () => {
    const out = renderAccounts(140, true)
    expect(out).not.toContain('beta 3')
    expect(out).not.toContain('gamma !')
  })

  test('hidden with one account', () => {
    const out = renderAccounts(140, false)
    expect(out).not.toContain(' · +')
    expect(out).not.toContain('beta')
  })
})
