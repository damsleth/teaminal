import { expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { accountRef } from '../account'
import { createGraphClient } from '../graph/client'
import { openAccount } from '../state/accountStore'
import { createAppStore } from '../state/store'
import { DiagnosticsModal } from './DiagnosticsModal'
import { SessionProvider, type SessionApi } from './SessionContext'
import { StoreProvider } from './StoreContext'

const client = (p: string | null) =>
  createGraphClient({ account: accountRef(p), audience: 'graph', fallback: false })

const session = (active: string | null): SessionApi => ({
  getActiveProfile: () => active,
  switchAccount: async () => {},
  retryRealtime: () => {},
  reconcile: async () => {},
  setForeground: () => {},
  retry: async () => {},
  running: () => [],
  clientFor: () => client(active),
  client: () => client(active),
})

const render = (store: ReturnType<typeof createAppStore>, active: string | null) =>
  renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session(active)}>
        <DiagnosticsModal />
      </SessionProvider>
    </StoreProvider>,
    { columns: 100 },
  ).replace(/\x1b\[[0-9;]*m/g, '')

test('several open accounts: an overview row each, the foreground selected', () => {
  const store = createAppStore()
  store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha', 'beta'] } }))
  openAccount(store, accountRef('alpha'), { foreground: true })
  const beta = openAccount(store, accountRef('beta'), { foreground: false })
  beta.set({ conn: 'authError', realtimeState: 'reconnecting' })
  store.set({ modal: { kind: 'diagnostics' } })
  const lines = render(store, 'alpha').split('\n')
  const row = (label: string) =>
    lines.find((l) => l.includes(` ${label} `) && l.includes('graph+ic3'))
  expect(row('alpha')).toContain('▸ alpha')
  expect(row('beta')).toMatch(/authError\s+reconnecting/)
  expect(lines.some((l) => l.includes('{messages,list,names}.beta.json'))).toBe(true)
  expect(lines.some((l) => l.includes('j/k: account'))).toBe(true)
})

test('one account: no overview', () => {
  const store = createAppStore(accountRef('alpha'))
  store.set({ modal: { kind: 'diagnostics' } })
  const out = render(store, 'alpha')
  expect(out).toContain('profile: alpha')
  expect(out).not.toContain('{messages,list,names}')
  expect(out).not.toContain('j/k: account')
})
