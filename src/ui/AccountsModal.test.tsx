// Accounts modal in concurrent mode: one row per account with its own state,
// and Enter / r / t act on that row's account. Renders the real modal with a
// fake terminal input and a fake SessionApi that records what it is asked.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { accountRef } from '../account'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { createGraphClient } from '../graph/client'
import { openAccount } from '../state/accountStore'
import { createAppStore } from '../state/store'
import { AccountsModal } from './AccountsModal'
import { SessionProvider, type SessionApi } from './SessionContext'
import { StoreProvider } from './StoreContext'

const realXdg = process.env.XDG_CONFIG_HOME
let cfg = ''
beforeEach(() => {
  cfg = mkdtempSync(join(tmpdir(), 'teaminal-accounts-modal-'))
  process.env.XDG_CONFIG_HOME = cfg
})
afterEach(() => {
  resetAuth()
  if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = realXdg
  rmSync(cfg, { recursive: true, force: true })
})

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

function mount({
  retry = async () => {},
  switchAccount = async () => {},
  concurrent = true,
  disabledAccounts = [],
  running = 'alpha',
}: {
  retry?: (profile: string) => Promise<void>
  switchAccount?: (profile: string | null) => Promise<void>
  concurrent?: boolean
  disabledAccounts?: string[]
  running?: string
} = {}) {
  const calls: string[] = []
  const owaPiggy: string[][] = []
  setAuthRunner(async (args) => {
    owaPiggy.push(args)
    return { stdout: '', stderr: '', exitCode: 0 }
  })
  const store = createAppStore()
  const accounts = {
    accounts: ['alpha', 'beta', 'gamma'],
    activeAccount: 'alpha',
    disabledAccounts,
  }
  // The same accounts on disk: the modal persists through the config file.
  mkdirSync(join(cfg, 'teaminal'), { recursive: true })
  writeFileSync(join(cfg, 'teaminal', 'config.json'), JSON.stringify(accounts))
  store.set((s) => ({ settings: { ...s.settings, ...accounts, concurrentAccounts: true } }))
  openAccount(store, accountRef('alpha'), { foreground: true }).set({
    conn: 'online',
    unreadByChatId: { c1: { unreadCount: 2, mentionCount: 0 } },
  })
  openAccount(store, accountRef('beta'), { foreground: false }).set({ conn: 'authError' })
  openAccount(store, accountRef('gamma'), { foreground: false }).set({ conn: 'offline' })
  store.set({ modal: { kind: 'accounts', mode: 'list', cursor: 0, accounts: [] } })

  const api: SessionApi = {
    concurrent,
    getActiveProfile: () => running,
    switchAccount: async (p) => {
      calls.push(`switch:${p}`)
      await switchAccount(p)
    },
    retryRealtime: () => {},
    reconcile: async () => void calls.push('reconcile'),
    setForeground: (p) => {
      calls.push(`foreground:${p}`)
      store.set({ modal: null })
    },
    retry: async (p) => {
      calls.push(`retry:${p}`)
      await retry(p)
    },
    running: () => [accountRef('alpha')],
    clientFor: () => {
      throw new Error('unused')
    },
    client: () =>
      createGraphClient({ account: accountRef('alpha'), audience: 'graph', fallback: false }),
  }

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean }
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
    rows: number
  }
  stdout.columns = 120
  stdout.rows = 30
  let frame = ''
  stdout.on('data', (d: Buffer) => (frame = plain(d.toString())))
  const app = render(
    <StoreProvider store={store}>
      <SessionProvider api={api}>
        <AccountsModal />
      </SessionProvider>
    </StoreProvider>,
    { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  const press = async (keys: string) => {
    for (const k of keys) {
      stdin.write(k)
      await tick()
    }
  }
  return { store, calls, owaPiggy, app, press, frame: () => frame }
}

const configFile = () =>
  JSON.parse(readFileSync(join(cfg, 'teaminal', 'config.json'), 'utf8')) as Record<string, unknown>

test('each row shows its own account: state, routing, unread', async () => {
  const { app, frame } = mount()
  await tick()
  const rows = frame().split('\n')
  const row = (p: string) => rows.find((r) => r.includes(` ${p}  `)) ?? ''
  expect(row('alpha')).toContain('alpha  foreground  [graph+ic3]  1 unread')
  expect(row('beta')).toContain('beta  auth expired  [graph+ic3]')
  expect(row('gamma')).toContain('gamma  offline  [graph+ic3]')
  expect(frame()).toContain('r retry failed')
  app.unmount()
})

test('Enter swaps to that account at once and persists it', async () => {
  const { store, calls, app, press } = mount()
  await tick()
  await press('j')
  await press('\r')
  await tick(80)
  expect(calls).toEqual(['foreground:beta'])
  expect(store.get().modal).toBeNull()
  expect(configFile().activeAccount).toBe('beta')
  app.unmount()
})

test('a switch that ends after another modal opened leaves that modal open', async () => {
  let release = () => {}
  const { store, calls, app, press } = mount({
    concurrent: false,
    switchAccount: () => new Promise<void>((r) => (release = r)),
  })
  await tick()
  await press('j')
  await press('\r')
  await tick(80)
  expect(calls).toEqual(['switch:beta'])
  store.set({ modal: { kind: 'activity', cursor: 0 } })
  release()
  await tick()
  expect(store.get().modal?.kind).toBe('activity')
  app.unmount()
})

test('single mode rows keep their old text', async () => {
  const { app, frame } = mount({ concurrent: false })
  await tick()
  expect(frame()).toContain('alpha  active  [graph+ic3]')
  expect(frame()).not.toContain('foreground')
  expect(frame()).not.toContain('r retry')
  app.unmount()
})

test('r on an auth-expired row reseeds that profile, then retries it; offline only retries', async () => {
  const { calls, owaPiggy, app, press, frame } = mount()
  await tick()
  // alpha is healthy: r does nothing.
  await press('r')
  expect(calls).toEqual([])
  await press('j')
  await press('r')
  await tick(80)
  expect(owaPiggy).toEqual([['reseed', '--profile', 'beta']])
  expect(calls).toEqual(['retry:beta'])
  await press('j')
  await press('r')
  await tick(80)
  expect(owaPiggy).toHaveLength(1)
  expect(calls).toEqual(['retry:beta', 'retry:gamma'])
  expect(frame()).not.toContain('Restarting')
  app.unmount()
})

test('a failed retry names the account', async () => {
  const { app, press, frame } = mount({
    retry: async () => {
      throw new Error('socket hang up')
    },
  })
  await tick()
  await press('jj')
  await press('r')
  await tick(80)
  expect(frame()).toContain('gamma: socket hang up')
  app.unmount()
})

test("t cycles that row's routing, not the foreground's", async () => {
  const { store, app, press } = mount()
  await tick()
  await press('jj')
  await press('t')
  await tick(80)
  expect(store.get().settings.chatRoutingByAccount).toEqual({ gamma: 'ic3+graph' })
  expect(configFile().chatRoutingByAccount).toEqual({ gamma: 'ic3+graph' })
  app.unmount()
})

test('Space turns the focused account off and on again; nothing else changes', async () => {
  const { store, calls, app, press, frame } = mount()
  await tick()
  await press('j')
  await press(' ')
  await tick(80)
  expect(calls).toEqual(['reconcile'])
  expect(configFile()).toMatchObject({
    accounts: ['alpha', 'beta', 'gamma'],
    activeAccount: 'alpha',
    disabledAccounts: ['beta'],
  })
  expect(frame()).toContain('beta  off  [graph+ic3]')
  expect(frame()).toContain('Space on/off')
  // A second Space works from the first one's settings.
  await press(' ')
  await tick(80)
  expect(calls).toEqual(['reconcile', 'reconcile'])
  expect(store.get().settings.disabledAccounts).toEqual([])
  expect(configFile().disabledAccounts).toEqual([])
  expect(configFile().accounts).toEqual(['alpha', 'beta', 'gamma'])
  app.unmount()
})

test('Space on the foreground account moves activeAccount to the next enabled one', async () => {
  const { calls, app, press } = mount({ disabledAccounts: ['beta'] })
  await tick()
  await press(' ')
  await tick(80)
  expect(configFile()).toMatchObject({
    activeAccount: 'gamma',
    disabledAccounts: ['beta', 'alpha'],
  })
  // Concurrent mode: reconcile moves the foreground; no switch.
  expect(calls).toEqual(['reconcile'])
  app.unmount()
})

test('single mode: Space on the running account switches to the next enabled one; a turned-off account cannot be picked', async () => {
  const { calls, app, press, frame } = mount({ concurrent: false })
  await tick()
  await press(' ')
  await tick(80)
  expect(calls).toEqual(['reconcile', 'switch:beta'])
  expect(configFile()).toMatchObject({ activeAccount: 'beta', disabledAccounts: ['alpha'] })
  expect(frame()).toContain('alpha  active  off  [graph+ic3]')
  await press('\r')
  await tick(80)
  expect(calls).toEqual(['reconcile', 'switch:beta'])
  expect(frame()).toContain('alpha is off: Space turns it on')
  app.unmount()
})

test('single mode: turning off the last enabled account falls back to the default profile, like removing it', async () => {
  const { calls, app, press } = mount({ concurrent: false, disabledAccounts: ['beta', 'gamma'] })
  await tick()
  await press(' ')
  await tick(80)
  expect(calls).toEqual(['reconcile', 'switch:null'])
  expect(configFile()).toMatchObject({ activeAccount: null })
  app.unmount()
})

test('removing a turned-off account drops it from disabledAccounts too', async () => {
  const { app, press } = mount({ disabledAccounts: ['beta'] })
  await tick()
  await press('j')
  await press('d')
  await press('y')
  await tick(80)
  expect(configFile()).toMatchObject({ accounts: ['alpha', 'gamma'], disabledAccounts: [] })
  app.unmount()
})

test('single mode: a turned-off activeAccount never becomes the switch target', async () => {
  // activeAccount alpha is off (startup ran beta instead); turning beta off
  // moves to gamma, not back to alpha.
  const { calls, app, press } = mount({
    concurrent: false,
    disabledAccounts: ['alpha'],
    running: 'beta',
  })
  await tick()
  await press('j')
  await press(' ')
  await tick(80)
  expect(calls).toEqual(['reconcile', 'switch:gamma'])
  expect(configFile()).toMatchObject({
    activeAccount: 'gamma',
    disabledAccounts: ['alpha', 'beta'],
  })
  app.unmount()
})

test('single mode: turning off the destination of a pending switch moves on to the next enabled one', async () => {
  // The fake keeps reporting alpha as running, like a switch whose stop has
  // not finished yet.
  const { calls, app, press } = mount({ concurrent: false })
  await tick()
  await press(' ')
  await tick(80)
  await press('j')
  await press(' ')
  await tick(80)
  expect(calls).toEqual(['reconcile', 'switch:beta', 'reconcile', 'switch:gamma'])
  expect(configFile()).toMatchObject({
    activeAccount: 'gamma',
    disabledAccounts: ['alpha', 'beta'],
  })
  app.unmount()
})
