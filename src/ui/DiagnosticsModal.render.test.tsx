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
import type { TransportStats } from '../realtime/transport'
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

// Mount with a keyboard and capture the last frame.
function mountInteractive(store: ReturnType<typeof createAppStore>, api: SessionApi) {
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
  return {
    frame: () => frame,
    press: async (k: string) => {
      stdin.write(k)
      await tick()
    },
    unmount: () => app.unmount(),
  }
}

const stats = (over: Partial<TransportStats>): TransportStats => ({
  frames: { '1::': 0, '2::': 0, '3': 0, '5': 0, json: 0, other: 0 },
  mapped: 0,
  dropped: 0,
  lastEventAt: null,
  reconnects: 0,
  ...over,
})

test('push liveness follows the selected account; never before the first event', async () => {
  const store = createAppStore()
  store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha', 'beta'] } }))
  openAccount(store, accountRef('alpha'), { foreground: true }).set({ realtimeState: 'connected' })
  openAccount(store, accountRef('beta'), { foreground: false }).set({ realtimeState: 'error' })
  store.set({ modal: { kind: 'diagnostics' } })
  const betaId = accountRef('beta').id
  const asked: string[] = []
  const lastEventAt = Date.now() - 4_000
  const ui = mountInteractive(store, {
    ...session('alpha'),
    realtimeStats: (id) => {
      asked.push(id ?? 'foreground')
      return id === betaId
        ? stats({ reconnects: 10, dropped: 2 })
        : stats({ lastEventAt, reconnects: 1 })
    },
  })
  try {
    await tick()
    expect(ui.frame()).toContain(
      'realtime: connected · last event 4s ago · reconnects 1 · dropped 0',
    )
    await ui.press('j')
    expect(ui.frame()).toContain('realtime: error · last event never · reconnects 10 · dropped 2')
    expect(asked).toContain(betaId)
  } finally {
    ui.unmount()
  }
})

test('no push line without push stats', () => {
  const store = createAppStore(accountRef('alpha'))
  store.set({ modal: { kind: 'diagnostics' } })
  const out = renderOnce(store, 'alpha')
  expect(out).toContain('realtime: off')
  expect(out).not.toContain('last event')
})

test('the idle clock advances once a second and stops on unmount', async () => {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const live = new Set<unknown>()
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const id = realSet(fn, ms)
    if (ms === 1000) live.add(id)
    return id
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
    live.delete(id)
    realClear(id)
  }) as typeof clearInterval
  const store = createAppStore(accountRef('alpha'))
  store.set({ modal: { kind: 'diagnostics' } })
  const lastEventAt = Date.now() - 5_000
  const ui = mountInteractive(store, {
    ...session('alpha'),
    realtimeStats: () => stats({ lastEventAt }),
  })
  try {
    await tick()
    expect(ui.frame()).toContain('last event 5s ago')
    expect(live.size).toBe(1)
    await tick(1_100)
    expect(ui.frame()).toContain('last event 6s ago')
    ui.unmount()
    expect(live.size).toBe(0)
  } finally {
    ui.unmount()
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
})
