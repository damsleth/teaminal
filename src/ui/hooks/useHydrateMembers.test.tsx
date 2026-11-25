import { afterEach, expect, test } from 'bun:test'
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import { accountRef } from '../../account'
import { __resetForTests as resetAuth, __setRunnerForTests } from '../../auth/owaPiggy'
import {
  __resetForTests as resetClient,
  __setTransportForTests,
  createGraphClient,
  currentAccountContext,
  setAudiencePreference,
} from '../../graph/client'
import { createAppStore, type Focus } from '../../state/store'
import { SessionProvider, type SessionApi } from '../SessionContext'
import { useHydrateMembers } from './useHydrateMembers'

afterEach(() => {
  resetClient()
  resetAuth()
})

const jwt = (payload: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

function Probe(props: { focus: Focus; store: ReturnType<typeof createAppStore> }) {
  useHydrateMembers(props.focus, props.store, 5)
  return null
}

test('a failed member hydrate is retried after a delay', async () => {
  setAudiencePreference('graph', { fallback: false })
  __setRunnerForTests(async () => ({
    stdout: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    stderr: '',
    exitCode: 0,
  }))
  let calls = 0
  __setTransportForTests(async () => {
    calls++
    if (calls === 1) return new Response('nope', { status: 404 })
    return new Response(
      JSON.stringify({
        id: 'c1',
        chatType: 'oneOnOne',
        createdDateTime: '2026-01-01T00:00:00Z',
        members: [{ id: 'm', displayName: 'Alice' }],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  })
  const store = createAppStore(accountRef('test'))
  store.set({
    chats: [{ id: 'c1', chatType: 'oneOnOne', createdDateTime: '2026-01-01T00:00:00Z' }],
  })
  const api: SessionApi = {
    getActiveProfile: () => 'test',
    client: () => createGraphClient(currentAccountContext()),
    switchAccount: async () => {},
  }
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  const ink = render(
    <SessionProvider api={api}>
      <Probe focus={{ kind: 'chat', chatId: 'c1' }} store={store} />
    </SessionProvider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
  )
  for (let i = 0; i < 50 && !store.get().chats[0]?.members; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  ink.unmount()
  expect(calls).toBe(2)
  expect(store.get().chats[0]?.members?.[0]?.displayName).toBe('Alice')
})
