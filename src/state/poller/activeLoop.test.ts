// makeActiveLoop driven directly, with its target injected: the loop polls
// whatever target() names, not the store's focus, and drops a page whose
// target moved while it was in flight.

import { accountRef } from '../../account'
import { accountStore } from '../accountStore'
import { createGraphClient } from '../../graph/client'
import { afterEach, expect, test } from 'bun:test'
import { __resetForTests, __setTransportForTests } from '../../graph/client'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../../auth/owaPiggy'
import type { ChatMessage } from '../../types'
import { createAppStore, type ConvKey, type Focus } from '../store'
import { makeActiveLoop } from './activeLoop'
import { makeSleeper } from './sleeper'

const testClient = () =>
  createGraphClient({ account: accountRef(undefined), audience: 'graph', fallback: false })

function primeAuth(): void {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + 3600
  setAuthRunner(async () => ({
    stdout: `${b64({ alg: 'none' })}.${b64({ exp, oid: 'me-oid' })}.sig`,
    stderr: '',
    exitCode: 0,
  }))
}

const message = (id: string, text: string): ChatMessage => ({
  id,
  createdDateTime: '2026-04-29T09:00:00Z',
  body: { contentType: 'text', content: text },
  from: { user: { id: 'u-alice', displayName: 'Alice Nordmann' } },
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await Bun.sleep(5)
  }
}

afterEach(() => {
  __resetForTests()
  resetAuth()
})

function startLoop(target: () => Focus) {
  const store = createAppStore(accountRef('test'))
  let stopped = false
  const sleeper = makeSleeper()
  const run = makeActiveLoop({
    store: accountStore(store),
    target,
    getClient: testClient,
    sleeper,
    intervalMs: 99_999,
    seen: new Map<ConvKey, Set<string>>(),
    setActiveAbort: () => {},
    isStopped: () => stopped,
    reportError: () => {},
  })
  const done = run()
  return {
    store,
    sleeper,
    stop: async () => {
      stopped = true
      sleeper.close()
      await done
    },
  }
}

test('polls the injected target, not the store focus', async () => {
  primeAuth()
  const fetched: string[] = []
  __setTransportForTests(async (url) => {
    const m = url.match(/\/chats\/([^/]+)\/messages/)
    fetched.push(m ? decodeURIComponent(m[1]!) : url)
    return Response.json({ value: [message('m1', 'Two compact layout options landed.')] })
  })
  const loop = startLoop(() => ({ kind: 'chat', chatId: 'design' }))
  loop.store.set({ focus: { kind: 'chat', chatId: 'chat-a' } })
  await waitFor(() => loop.store.get().messagesByConvo['chat:design'] !== undefined)
  await loop.stop()
  expect(fetched).toEqual(['design'])
  expect(loop.store.get().messagesByConvo['chat:chat-a']).toBeUndefined()
})

test('drops a page whose target changed while it was in flight', async () => {
  primeAuth()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let calls = 0
  __setTransportForTests(async () => {
    calls++
    if (calls === 1) await gate
    return Response.json({ value: [message(`m${calls}`, 'hello')] })
  })
  let target: Focus = { kind: 'chat', chatId: 'chat-a' }
  const loop = startLoop(() => target)
  await waitFor(() => calls === 1)
  target = { kind: 'chat', chatId: 'design' }
  release()
  await Bun.sleep(30)
  // The stale page for chat-a is not applied.
  expect(loop.store.get().messagesByConvo['chat:chat-a']).toBeUndefined()
  loop.sleeper.wake()
  await waitFor(() => loop.store.get().messagesByConvo['chat:design'] !== undefined)
  await loop.stop()
})
