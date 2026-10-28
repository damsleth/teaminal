import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountRef } from '../account'
import { createAccountManager } from './accountManager'
import { getMessageCachePath, loadMessageCache } from './messageCachePersistence'
import { createAppStore, emptyMessageCache } from './store'

const realSeed = process.env.TEAMINAL_SEED
const realXdg = process.env.XDG_CACHE_HOME
let cacheRoot = ''

afterEach(() => {
  if (realSeed === undefined) delete process.env.TEAMINAL_SEED
  else process.env.TEAMINAL_SEED = realSeed
  if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = realXdg
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true })
  cacheRoot = ''
})

describe('AccountManager', () => {
  test('seeded mode: start and switch load each account; stopAll is idempotent', async () => {
    process.env.TEAMINAL_SEED = 'fixtures'
    const store = createAppStore()
    const m = createAccountManager(store, 'alpha')
    expect(store.get().account?.id).toBe(accountRef('alpha').id)
    await m.start(() => {})
    const alphaTopic = store.get().chats.find((c) => c.topic)?.topic
    expect(alphaTopic).toBeTruthy()

    const generation = store.get().accountGeneration
    await m.switchAccount('beta')
    expect(m.activeProfile()).toBe('beta')
    expect(store.get().account?.id).toBe(accountRef('beta').id)
    expect(store.get().accountGeneration).toBe(generation + 1)
    expect(store.get().chats.find((c) => c.topic)?.topic).toBe(alphaTopic!.toUpperCase())

    await m.stopAll()
    await m.stopAll()
  })

  test("caches persist to the active profile's path", async () => {
    delete process.env.TEAMINAL_SEED
    cacheRoot = mkdtempSync(join(tmpdir(), 'teaminal-manager-'))
    process.env.XDG_CACHE_HOME = cacheRoot
    const store = createAppStore()
    const m = createAccountManager(store, 'alpha')
    const cache = emptyMessageCache([
      {
        id: 'm1',
        createdDateTime: '2026-01-01T00:00:00Z',
        body: { contentType: 'text', content: 'hi' },
      },
    ])
    store.set({ messageCacheByConvo: { 'chat:c1': cache } })
    await m.stopAll() // flushes the debounced write

    const path = getMessageCachePath(process.env, 'alpha')
    expect(existsSync(path)).toBe(true)
    expect(Object.keys(loadMessageCache(path))).toEqual(['chat:c1'])
    expect(existsSync(getMessageCachePath(process.env, null))).toBe(false)
  })
})
