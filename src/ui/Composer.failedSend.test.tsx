// A message must only ever go to, or be restored into, the conversation it
// was typed in. Renders the real Composer with a fake terminal input; the
// real sendMessage / editChatMessageContent run against a Graph transport
// the test controls, so chats can be switched while a request is open.

import { afterEach, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { accountRef } from '../account'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests as resetClient,
  __setTransportForTests as setTransport,
  createGraphClient,
} from '../graph/client'
import { createAppStore, resetAccountScopedState } from '../state/store'
import { Composer } from './Composer'
import { SessionProvider } from './SessionContext'
import { StoreProvider } from './StoreContext'

afterEach(() => {
  resetClient()
  resetAuth()
})

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

function mount(initial: Parameters<ReturnType<typeof createAppStore>['set']>[0]) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
    JSON.stringify({ exp, oid: 'me' }),
  ).toString('base64url')}.sig`
  setAuthRunner(async () => ({ stdout: jwt, stderr: '', exitCode: 0 }))
  const store = createAppStore(accountRef('test'))
  store.set(initial)
  // Every drafts state the store ever held.
  const draftHistory: Record<string, string>[] = []
  store.subscribe(() => draftHistory.push({ ...store.get().draftsByConvo }))
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean }
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
    rows: number
  }
  stdout.columns = 80
  stdout.rows = 24
  // The last frame that showed the composer's text.
  let screen = ''
  stdout.on('data', (d: Buffer) => {
    const text = d.toString()
    if (text.includes('>')) screen = text
  })
  const app = render(
    <StoreProvider store={store}>
      <SessionProvider
        api={{
          getActiveProfile: () => null,
          switchAccount: async () => {},
          client: () =>
            createGraphClient({ account: accountRef(null), audience: 'graph', fallback: false }),
        }}
      >
        <Composer />
      </SessionProvider>
    </StoreProvider>,
    { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  return { store, stdin, app, draftHistory, screen: () => screen }
}

// A Graph transport that holds each request until the test settles it.
function heldTransport() {
  const requests: { url: string; method: string; settle: (status: number) => void }[] = []
  setTransport(
    (url, init) =>
      new Promise((resolve) => {
        requests.push({
          url,
          method: init.method ?? 'GET',
          settle: (status) =>
            resolve(
              new Response(status < 300 ? '{"id":"s1","body":{"content":"x"}}' : '{}', {
                status,
              }),
            ),
        })
      }),
  )
  return requests
}

test('a send that fails after switching chats goes back to its own chat, not the open one', async () => {
  const requests = heldTransport()
  const { store, stdin, app } = mount({
    focus: { kind: 'chat', chatId: 'a' },
    inputZone: 'composer',
    draftsByConvo: { 'chat:b': 'for b' },
  })
  await tick()
  stdin.write('hello')
  await tick()
  stdin.write('\n') // Ctrl+J / LF sends
  await tick()
  expect(requests.map((r) => r.url).some((u) => u.includes('/chats/a/messages'))).toBe(true)

  store.set({ focus: { kind: 'chat', chatId: 'b' } })
  await tick()
  requests.at(-1)!.settle(500)
  await tick(80)

  expect(store.get().draftsByConvo['chat:a']).toBe('hello')
  expect(store.get().draftsByConvo['chat:b']).toBe('for b')
  app.unmount()
})

test("switching chats never writes one chat's text into the other's draft, even briefly", async () => {
  heldTransport()
  const { store, stdin, app, draftHistory } = mount({
    focus: { kind: 'chat', chatId: 'a' },
    inputZone: 'composer',
    draftsByConvo: { 'chat:b': 'for b' },
  })
  await tick()
  stdin.write('hello')
  await tick()
  store.set({ focus: { kind: 'chat', chatId: 'b' } })
  store.set({ focus: { kind: 'chat', chatId: 'a' } })
  store.set({ focus: { kind: 'chat', chatId: 'b' } })
  await tick(80)
  for (const drafts of draftHistory) {
    expect(drafts['chat:b'] ?? 'for b').toBe('for b')
    expect(drafts['chat:a'] ?? 'hello').toBe('hello')
  }
  app.unmount()
})

test('send right after a switch cannot send the previous chat’s text', async () => {
  const requests = heldTransport()
  const { store, stdin, app } = mount({
    focus: { kind: 'chat', chatId: 'a' },
    inputZone: 'composer',
  })
  await tick()
  stdin.write('for a only')
  await tick()
  // Switch and press send in the same moment.
  store.set({ focus: { kind: 'chat', chatId: 'b' } })
  stdin.write('\n')
  await tick(80)
  expect(requests.some((r) => r.url.includes('/chats/b/messages'))).toBe(false)
  app.unmount()
})

test('a failed edit is resumed with the revised text, not the original', async () => {
  const requests = heldTransport()
  const { store, stdin, app, screen } = mount({
    me: { id: 'me', displayName: 'Me' } as never,
    focus: { kind: 'chat', chatId: 'a' },
    inputZone: 'composer',
    messagesByConvo: {
      'chat:a': [
        {
          id: 'm1',
          createdDateTime: '2026-01-01T00:00:00Z',
          messageType: 'message',
          body: { contentType: 'text', content: 'original' },
          from: { user: { id: 'me', displayName: 'Me' } },
        },
      ],
    },
  })
  await tick()
  store.set({ editingMessageId: 'm1', inputZone: 'composer' })
  await tick()
  stdin.write(' revised')
  await tick()
  stdin.write('\n')
  await tick()
  requests.at(-1)!.settle(500)
  await tick(80)
  expect(store.get().editingMessageId).toBe('m1')
  expect(screen()).toContain('original revised')
  app.unmount()
})

test('text typed under one account is never sent from another, even in the same chat', async () => {
  const requests = heldTransport()
  const { store, stdin, app } = mount({
    focus: { kind: 'chat', chatId: 'a' },
    inputZone: 'composer',
  })
  await tick()
  stdin.write('secret for old account')
  await tick()
  // Switch account and come back to a chat with the same id, then send at
  // once, before the composer has re-rendered.
  resetAccountScopedState(store, accountRef('other'))
  store.set({ focus: { kind: 'chat', chatId: 'a' }, inputZone: 'composer' })
  stdin.write('\n')
  await tick(80)
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0)
  app.unmount()
})

test('a paste then a chat switch: the paste stays in the chat it was pasted into', async () => {
  // Ink hands a paste over only once it is complete, and input is read in
  // order, so a key-driven switch can't land in the middle of a paste.
  heldTransport()
  const { store, stdin, app, draftHistory } = mount({
    focus: { kind: 'chat', chatId: 'a' },
    inputZone: 'composer',
  })
  await tick()
  stdin.write('\x1b[200~secret-')
  await tick()
  stdin.write('for-A\x1b[201~')
  await tick()
  store.set({ focus: { kind: 'chat', chatId: 'b' } })
  await tick()
  stdin.write('x')
  await tick(80)
  for (const drafts of draftHistory) expect(drafts['chat:b'] ?? '').not.toContain('for-A')
  expect(store.get().draftsByConvo['chat:a']).toBe('secret-for-A')
  expect(store.get().draftsByConvo['chat:b']).toBe('x')
  app.unmount()
})
