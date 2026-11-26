import { afterEach, beforeEach, expect, test } from 'bun:test'
import { render, renderToString } from 'ink'
import { PassThrough } from 'node:stream'
import { accountRef } from '../account'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { createGraphClient } from '../graph/client'
import type { ActivityItem } from '../graph/teamsActivity'
import { openAccount, setForeground } from '../state/accountStore'
import { accountSlice, createAppStore } from '../state/store'
import { ActivityModal } from './ActivityModal'
import { SessionProvider, type SessionApi } from './SessionContext'
import { StoreProvider } from './StoreContext'

type AppStore = ReturnType<typeof createAppStore>

const client = (p: string | null) =>
  createGraphClient({ account: accountRef(p), audience: 'graph', fallback: false })

const session = (store: AppStore, over: Partial<SessionApi> = {}): SessionApi => ({
  getActiveProfile: () => null,
  switchAccount: async () => {},
  retryRealtime: () => {},
  reconcile: async () => {},
  setForeground: (p, opts) => setForeground(store, accountRef(p).id, opts),
  retry: async () => {},
  running: () => [],
  concurrent: true,
  clientFor: () => client(null),
  client: () => client(null),
  ...over,
})

// The on-open refresh asks owa-piggy for each account's token: record the
// profile and fail, so nothing reaches the network.
let tokenProfiles: string[] = []
const realFetch = globalThis.fetch
beforeEach(() => {
  tokenProfiles = []
  setAuthRunner(async (args) => {
    const i = args.indexOf('--profile')
    tokenProfiles.push(i >= 0 ? args[i + 1]! : 'default')
    return { stdout: '', stderr: 'no token in tests', exitCode: 1 }
  })
  globalThis.fetch = (async () => {
    throw new Error('no network in tests')
  }) as unknown as typeof fetch
})
afterEach(() => {
  resetAuth()
  globalThis.fetch = realFetch
})

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

function item(id: string, partial: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    kind: 'mention',
    chatId: `19:${id}@unq.gbl.spaces`,
    senderDisplayName: 'Bob Nordmann',
    preview: `about ${id}`,
    createdAt: '2026-05-20T10:00:00Z',
    isRead: false,
    ...partial,
  }
}

const me = (upn: string) => ({ id: 'u1', displayName: 'Alice', userPrincipalName: upn, mail: upn })

// alpha (foreground), beta, gamma open; beta has no notifications. alpha and
// gamma share item ids, so a write landing in the wrong account shows.
function threeAccounts(): AppStore {
  const store = createAppStore()
  store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha', 'beta', 'gamma'] } }))
  openAccount(store, accountRef('alpha'), { foreground: true }).set({
    me: me('alice@contoso.onmicrosoft.com'),
    activityFeed: [item('n1', { senderDisplayName: 'Kari Nordmann' }), item('n2')],
    unreadMentionCount: 2,
  })
  openAccount(store, accountRef('beta'), { foreground: false }).set({
    me: me('alice@example.com'),
  })
  openAccount(store, accountRef('gamma'), { foreground: false }).set({
    me: me('alice@example.com'),
    activityFeed: [item('n1', { senderDisplayName: 'Ola Nordmann' })],
    unreadMentionCount: 1,
  })
  store.set({ modal: { kind: 'activity', cursor: 0 }, inputZone: 'menu' })
  return store
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

const renderOnce = (store: AppStore, api: SessionApi = session(store)) =>
  strip(
    renderToString(
      <StoreProvider store={store}>
        <SessionProvider api={api}>
          <ActivityModal />
        </SessionProvider>
      </StoreProvider>,
      { columns: 100 },
    ),
  )

function mount(store: AppStore, api: SessionApi = session(store)) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean }
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & { columns: number }
  stdout.columns = 100
  const out = { frame: '' }
  stdout.on('data', (d: Buffer) => (out.frame = strip(d.toString())))
  const app = render(
    <StoreProvider store={store}>
      <SessionProvider api={api}>
        <ActivityModal />
      </SessionProvider>
    </StoreProvider>,
    { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  const press = async (k: string) => {
    stdin.write(k)
    await tick()
  }
  return { out, press, unmount: () => app.unmount() }
}

const feed = (store: AppStore, p: string) => accountSlice(store.get(), accountRef(p).id)!

test('several accounts: grouped by account in sidebar order, empty ones left out', () => {
  const lines = renderOnce(threeAccounts()).split('\n')
  const at = (text: string) => lines.findIndex((l) => l.includes(text))
  expect(lines[at('Notifications')]).toContain('Notifications (3 unread)')
  expect(lines[at('Notifications')]).not.toContain('alpha')
  expect(lines[at('alpha ·')]).toContain('alpha · contoso.onmicrosoft.com')
  expect(lines[at('gamma ·')]).toContain('gamma · example.com')
  expect(at('beta')).toBe(-1)
  expect(at('alpha ·')).toBeLessThan(at('Kari Nordmann'))
  expect(at('Kari Nordmann')).toBeLessThan(at('gamma ·'))
  expect(at('gamma ·')).toBeLessThan(at('Ola Nordmann'))
  // The cursor starts on the first item, not on a header.
  expect(lines[at('Kari Nordmann')]).toMatch(/> ● @ Kari Nordmann/)
})

test('several accounts, none with notifications: the empty line', () => {
  const store = threeAccounts()
  setForeground(store, accountRef('beta').id)
  store.set({ modal: { kind: 'activity', cursor: 0 } })
  for (const p of ['alpha', 'gamma']) {
    const s = store.get()
    if (s.account?.id === accountRef(p).id) store.set({ activityFeed: [] })
    else
      store.set({
        backgroundAccounts: {
          ...s.backgroundAccounts,
          [accountRef(p).id]: { ...s.backgroundAccounts[accountRef(p).id]!, activityFeed: [] },
        },
      })
  }
  const out = renderOnce(store)
  expect(out).toContain('(no notifications)')
  expect(out).not.toContain('beta ·')
})

test('sidebar order, not foreground first', () => {
  const store = threeAccounts()
  setForeground(store, accountRef('gamma').id)
  store.set({ modal: { kind: 'activity', cursor: 0 } })
  const out = renderOnce(store)
  expect(out.indexOf('alpha ·')).toBeGreaterThan(-1)
  expect(out.indexOf('alpha ·')).toBeLessThan(out.indexOf('gamma ·'))
})

test('one open account (--profile): no header, the title names no account; refreshes it', async () => {
  const store = createAppStore(accountRef('alpha'))
  store.set((s) => ({
    settings: { ...s.settings, accounts: ['alpha', 'beta'] },
    me: me('alice@contoso.onmicrosoft.com'),
    activityFeed: [item('n1', { senderDisplayName: 'Kari Nordmann' })],
    modal: { kind: 'activity', cursor: 0 },
  }))
  const ui = mount(store, session(store, { concurrent: undefined }))
  try {
    await tick(100)
    const lines = ui.out.frame.split('\n')
    expect(lines.some((l) => l.includes('Notifications (1 unread)'))).toBe(true)
    expect(lines.some((l) => l.includes('alpha'))).toBe(false)
    expect(lines.some((l) => /> ● @ Kari Nordmann/.test(l))).toBe(true)
    expect([...new Set(tokenProfiles)]).toEqual(['alpha'])
  } finally {
    ui.unmount()
  }
})

test('opening refreshes every running account with its own token', async () => {
  const store = threeAccounts()
  const running = [accountRef('alpha'), accountRef('gamma')]
  const ui = mount(store, session(store, { running: () => running }))
  try {
    await tick(100)
    expect([...new Set(tokenProfiles)].sort()).toEqual(['alpha', 'gamma'])
  } finally {
    ui.unmount()
  }
})

test('j/k cross groups; Enter on another account brings it to the front and opens the chat', async () => {
  const store = threeAccounts()
  const calls: string[] = []
  const api = session(store, {
    setForeground: (p, opts) => {
      calls.push(`${p}:${opts?.restoreUi}`)
      setForeground(store, accountRef(p).id, opts)
    },
  })
  const ui = mount(store, api)
  try {
    await tick()
    await ui.press('j')
    await ui.press('j')
    expect(ui.out.frame).toMatch(/> ● @ Ola Nordmann/)
    await ui.press('j') // the last item: stays
    expect(ui.out.frame).toMatch(/> ● @ Ola Nordmann/)
    await ui.press('k')
    expect(ui.out.frame).toMatch(/> ● @ Bob Nordmann/)
    await ui.press('j')
    await ui.press('\r')
    expect(calls).toEqual(['gamma:false'])
    const s = store.get()
    expect(s.account?.id).toBe(accountRef('gamma').id)
    expect(s.focus).toEqual({ kind: 'chat', chatId: '19:n1@unq.gbl.spaces' })
    expect(s.modal).toBeNull()
    // Marked read in gamma only; alpha's item with the same id stays unread.
    expect(feed(store, 'gamma').activityFeed[0]!.isRead).toBe(true)
    expect(feed(store, 'gamma').unreadMentionCount).toBe(0)
    expect(feed(store, 'alpha').activityFeed.map((i) => i.isRead)).toEqual([false, false])
    expect(feed(store, 'alpha').unreadMentionCount).toBe(2)
  } finally {
    ui.unmount()
  }
})

test('Enter on a foreground item opens it without a swap', async () => {
  const store = threeAccounts()
  const calls: string[] = []
  const ui = mount(store, session(store, { setForeground: (p) => void calls.push(p) }))
  try {
    await tick()
    await ui.press('\r')
    expect(calls).toEqual([])
    expect(store.get().focus).toEqual({ kind: 'chat', chatId: '19:n1@unq.gbl.spaces' })
    expect(store.get().activityFeed.map((i) => i.isRead)).toEqual([true, false])
    expect(store.get().unreadMentionCount).toBe(1)
    expect(feed(store, 'gamma').activityFeed[0]!.isRead).toBe(false)
  } finally {
    ui.unmount()
  }
})

test('a marks every account read', async () => {
  const store = threeAccounts()
  const ui = mount(store)
  try {
    await tick()
    await ui.press('a')
    for (const p of ['alpha', 'gamma']) {
      expect(feed(store, p).activityFeed.every((i) => i.isRead)).toBe(true)
      expect(feed(store, p).unreadMentionCount).toBe(0)
    }
    expect(store.get().account?.id).toBe(accountRef('alpha').id)
    expect(ui.out.frame).toContain('Notifications')
    expect(ui.out.frame).not.toContain('unread)')
  } finally {
    ui.unmount()
  }
})

test('a long list scrolls to keep the cursor visible', () => {
  const store = threeAccounts()
  const many = Array.from({ length: 20 }, (_, i) =>
    item(`m${i}`, { senderDisplayName: `Sender ${String(i).padStart(2, '0')}` }),
  )
  store.set({ activityFeed: many, modal: { kind: 'activity', cursor: 19 } })
  const out = renderOnce(store)
  expect(out).toMatch(/> ● @ Sender 19/)
  expect(out).not.toContain('Sender 00')
  expect(out).toContain('gamma ·')
})
