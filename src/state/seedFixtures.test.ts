import { describe, expect, test } from 'bun:test'
import { accountRef } from '../account'
import { accountStore } from './accountStore'
import { applySeededState, BETA_PROFILE, GAMMA_PROFILE } from './seedFixtures'
import { createAppStore } from './store'

describe('collision fixtures', () => {
  test('beta reuses every alpha id with different text', () => {
    const alpha = createAppStore(accountRef('alpha'))
    const beta = createAppStore(accountRef(BETA_PROFILE))
    applySeededState(accountStore(alpha), 'alpha')
    applySeededState(accountStore(beta), BETA_PROFILE)
    const a = alpha.get()
    const b = beta.get()
    expect(b.me?.id).toBe(a.me?.id)
    expect(b.chats.map((c) => c.id)).toEqual(a.chats.map((c) => c.id))
    const ids = (s: typeof a) =>
      Object.entries(s.messagesByConvo).flatMap(([k, ms]) => ms.map((m) => `${k}/${m.id}`))
    expect(ids(b)).toEqual(ids(a))
    const topic = (s: typeof a) => s.chats.find((c) => c.topic)!.topic
    expect(topic(b)).not.toBe(topic(a))
    const body = (s: typeof a) => Object.values(s.messagesByConvo)[0]![0]!.body.content
    expect(body(b)).not.toBe(body(a))
  })

  test('gamma reuses every alpha id with a third text a filter tells apart', () => {
    const load = (p: string) => {
      const store = createAppStore(accountRef(p))
      applySeededState(accountStore(store), p)
      return store.get()
    }
    const a = load('alpha')
    const b = load(BETA_PROFILE)
    const g = load(GAMMA_PROFILE)
    expect(g.me?.id).toBe(a.me?.id)
    expect(g.chats.map((c) => c.id)).toEqual(a.chats.map((c) => c.id))
    // beta differs from alpha by case only; gamma differs from both.
    const topics = [a, b, g].map((s) => s.chats.find((c) => c.topic)!.topic!.toLowerCase())
    expect(topics[2]).not.toBe(topics[0])
    expect(topics[1]).toBe(topics[0])
    const body = (s: typeof a) => Object.values(s.messagesByConvo)[0]![0]!.body.content
    expect(body(g)).not.toBe(body(a))
  })
})
