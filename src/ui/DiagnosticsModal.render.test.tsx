import { afterEach, beforeEach, expect, test } from 'bun:test'
import { render, renderToString } from 'ink'
import { PassThrough } from 'node:stream'
import { accountRef } from '../account'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
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

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const jwt = (payload: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

// The modal fetches the selected account's token: never spawn owa-piggy here.
beforeEach(() => {
  setAuthRunner(async (args) => {
    const i = args.indexOf('--profile')
    const p = i >= 0 ? args[i + 1] : 'default'
    return { stdout: jwt({ exp: 4_000_000_000, tid: `tenant-${p}` }), stderr: '', exitCode: 0 }
  })
})
afterEach(() => resetAuth())

const renderOnce = (store: ReturnType<typeof createAppStore>, active: string | null) =>
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
  const lines = renderOnce(store, 'alpha').split('\n')
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
  const out = renderOnce(store, 'alpha')
  expect(out).toContain('profile: alpha')
  expect(out).not.toContain('{messages,list,names}')
  expect(out).not.toContain('j/k: account')
})

test('j selects the next account: its details, its token and r act on it', async () => {
  const store = createAppStore()
  store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha', 'beta'] } }))
  openAccount(store, accountRef('alpha'), { foreground: true }).set({ conn: 'online' })
  openAccount(store, accountRef('beta'), { foreground: false }).set({ conn: 'offline' })
  store.set({ modal: { kind: 'diagnostics' } })
  const calls: string[] = []
  const api: SessionApi = {
    ...session('alpha'),
    clientFor: (id) => {
      calls.push(`clientFor:${id}`)
      return client(id === accountRef('beta').id ? 'beta' : 'alpha')
    },
    retryRealtime: (id) => void calls.push(`retryRealtime:${id ?? 'foreground'}`),
  }
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean }
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & { columns: number }
  stdout.columns = 120
  let frame = ''
  stdout.on('data', (d: Buffer) => (frame = d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')))
  const app = render(
    <StoreProvider store={store}>
      <SessionProvider api={api}>
        <DiagnosticsModal />
      </SessionProvider>
    </StoreProvider>,
    { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  const press = async (k: string) => {
    stdin.write(k)
    await tick()
  }
  try {
    await tick()
    expect(frame).toContain('tid: tenant-alpha')
    await press('r')
    await press('j')
    expect(frame).toMatch(/▸ beta/)
    expect(frame).toContain('profile: beta')
    expect(frame).toContain('conn: offline')
    expect(frame).toContain('tid: tenant-beta')
    await press('r')
    const betaId = accountRef('beta').id
    expect(calls).toEqual([
      'retryRealtime:foreground',
      `clientFor:${betaId}`,
      `retryRealtime:${betaId}`,
    ])
    await press('k')
    expect(frame).toMatch(/▸ alpha/)
  } finally {
    app.unmount()
  }
})
