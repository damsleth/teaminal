import { expect, test } from 'bun:test'
import { accountRef } from '../account'
import { openAccount } from './accountStore'
import { accountDiagnostics } from './diagnostics'
import { createAppStore } from './store'

const ok = { ok: true } as const

test('one row per open account, in configured order, each from its own slot', () => {
  const store = createAppStore()
  store.set((s) => ({
    settings: {
      ...s.settings,
      accounts: ['alpha', 'beta'],
      chatRoutingByAccount: { beta: 'ic3-only' },
    },
  }))
  // beta opens first and holds the foreground; configured order still wins.
  const beta = openAccount(store, accountRef('beta'), { foreground: true })
  const alpha = openAccount(store, accountRef('alpha'), { foreground: false })
  // Same ids in both tenants; only the slot tells them apart.
  const polled = new Date('2026-01-01T10:00:00Z')
  alpha.set({
    conn: 'online',
    realtimeState: 'connected',
    lastListPollAt: polled,
    capabilities: { me: ok, chats: ok, joinedTeams: ok, presence: ok },
  })
  beta.set({
    conn: 'authError',
    realtimeState: 'error',
    capabilities: {
      me: ok,
      chats: ok,
      joinedTeams: ok,
      presence: { ok: false, reason: 'unauthorized', status: 401, message: 'denied' },
    },
  })

  const rows = accountDiagnostics(store.get(), { XDG_CACHE_HOME: '/cache' })
  expect(rows.map((r) => [r.ref.label, r.foreground, r.conn, r.realtimeState])).toEqual([
    ['alpha', false, 'online', 'connected'],
    ['beta', true, 'authError', 'error'],
  ])
  expect(rows[0]!.lastListPollAt).toBe(polled)
  expect(rows[1]!.lastListPollAt).toBeUndefined()
  expect(rows.map((r) => r.routing)).toEqual(['graph+ic3', 'ic3-only'])
  expect(rows.map((r) => r.capabilities)).toEqual(['4/4 ok', '3/4: presence'])
  expect(rows[0]!.cachePaths).toEqual([
    '/cache/teaminal/messages.alpha.json',
    '/cache/teaminal/list.alpha.json',
    '/cache/teaminal/names.alpha.json',
  ])
})

test('single mode: one row; the capability probe may still be running', () => {
  const store = createAppStore(accountRef(undefined))
  const rows = accountDiagnostics(store.get(), { XDG_CACHE_HOME: '/cache' })
  expect(rows).toHaveLength(1)
  expect(rows[0]!.capabilities).toBe('probing')
  expect(rows[0]!.cachePaths[0]).toBe('/cache/teaminal/messages.json')
})
