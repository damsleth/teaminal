import { describe, expect, test } from 'bun:test'
import { applySeededState, BETA_PROFILE } from './seedFixtures'
import { createAppStore } from './store'

describe('collision fixtures', () => {
  test('beta reuses every alpha id with different text', () => {
    const alpha = createAppStore()
    const beta = createAppStore()
    applySeededState(alpha, 'alpha')
    applySeededState(beta, BETA_PROFILE)
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
})
