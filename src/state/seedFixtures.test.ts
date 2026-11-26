import { afterEach, describe, expect, test } from 'bun:test'
import { accountRef } from '../account'
import { accountStore, openAccount } from './accountStore'
import { channelRoots, groupChannelThreads, replyCountForRoot } from './channelThreads'
import {
  applySeededState,
  BETA_PROFILE,
  GAMMA_PROFILE,
  SEED_CHANNEL_CONV,
  SEED_CHANNEL_ID,
  SEED_TEAM_ID,
} from './seedFixtures'
import { accountSlice, createAppStore } from './store'

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

describe('channel fixtures', () => {
  const realSeed = process.env.TEAMINAL_SEED
  afterEach(() => {
    if (realSeed === undefined) delete process.env.TEAMINAL_SEED
    else process.env.TEAMINAL_SEED = realSeed
  })

  const load = (seed: string, profile = 'alpha') => {
    process.env.TEAMINAL_SEED = seed
    const store = createAppStore(accountRef(profile))
    applySeededState(accountStore(store), profile)
    return store.get()
  }

  test('TEAMINAL_SEED=fixtures seeds no teams, channels or channel messages', () => {
    const s = load('fixtures')
    expect(s.teams).toEqual([])
    expect(s.channelsByTeam).toEqual({})
    expect(Object.keys(s.messagesByConvo).some((k) => !k.startsWith('chat:'))).toBe(false)
  })

  test('TEAMINAL_SEED=channels adds one channel whose stream groups into threads', () => {
    const s = load('channels')
    expect(s.chats.length).toBe(load('fixtures').chats.length)
    expect(s.teams.map((t) => t.id)).toEqual([SEED_TEAM_ID])
    expect(s.channelsByTeam[SEED_TEAM_ID]!.map((c) => c.id)).toEqual([SEED_CHANNEL_ID])
    const stream = s.messagesByConvo[SEED_CHANNEL_CONV]!
    expect(s.messageCacheByConvo[SEED_CHANNEL_CONV]!.messages).toBe(stream)
    expect(s.messageCacheByConvo[SEED_CHANNEL_CONV]!.fullyLoaded).toBe(false)
    const roots = channelRoots(stream)
    expect(roots.map((m) => m.id)).toEqual(['seed-ch-root-1', 'seed-ch-root-2'])
    for (const r of roots) expect(r.rootMessageId).toBe(r.id)
    const threads = groupChannelThreads(stream)
    expect(replyCountForRoot(threads, 'seed-ch-root-2')).toBe(2)
    expect(replyCountForRoot(threads, 'seed-ch-root-1')).toBe(1)
    // A reply whose root is outside the loaded window.
    expect(replyCountForRoot(threads, 'seed-ch-unloaded')).toBe(1)
    expect(roots.some((m) => m.id === 'seed-ch-unloaded')).toBe(false)
    for (const m of stream) {
      expect(m.from?.user?.displayName).toBeTruthy()
      expect(m.body.content).toBeTruthy()
      if (m.replyToId) expect(m.rootMessageId).toBe(m.replyToId)
    }
  })

  test('beta and gamma reuse the channel ids with their own text, in slots of one store', () => {
    process.env.TEAMINAL_SEED = 'channels'
    const store = createAppStore(accountRef('alpha'))
    applySeededState(accountStore(store), 'alpha')
    for (const p of [BETA_PROFILE, GAMMA_PROFILE]) {
      applySeededState(openAccount(store, accountRef(p), { foreground: false }), p)
    }
    const [a, b, g] = ['alpha', BETA_PROFILE, GAMMA_PROFILE].map((p) =>
      accountSlice(store.get(), accountRef(p).id)!,
    )
    const ids = (s: typeof a) => s!.messagesByConvo[SEED_CHANNEL_CONV]!.map((m) => m.id)
    const text = (s: typeof a) => [
      s!.teams[0]!.displayName,
      s!.channelsByTeam[SEED_TEAM_ID]![0]!.displayName,
      ...s!.messagesByConvo[SEED_CHANNEL_CONV]!.flatMap((m) => [
        m.body.content,
        m.from!.user!.displayName,
      ]),
    ]
    expect(ids(b)).toEqual(ids(a))
    expect(ids(g)).toEqual(ids(a))
    expect(text(b)).toEqual(text(a).map((t) => t!.toUpperCase()))
    expect(text(g)).toEqual(text(a).map((t) => `${t} (gamma)`))
    // alpha's own slice kept its normal-case text.
    expect(text(a)).toContain('Release notes draft is up.')
    expect(text(a)).not.toContain('RELEASE NOTES DRAFT IS UP.')
  })
})
