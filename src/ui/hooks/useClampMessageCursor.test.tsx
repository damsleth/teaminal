import { expect, test } from 'bun:test'
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import { createAppStore, type AppState, type Focus } from '../../state/store'
import type { ChatMessage } from '../../types'
import { useClampMessageCursor } from './useClampMessageCursor'

const focus: Focus = { kind: 'chat', chatId: 'c1' }
const msg = (id: string) =>
  ({
    id,
    createdDateTime: '2026-10-27T08:00:00Z',
    messageType: 'message',
    body: { contentType: 'text', content: id },
    from: { user: { id: 'u1', displayName: 'Alice' } },
  }) as unknown as ChatMessage

function Probe(props: {
  store: ReturnType<typeof createAppStore>
  byConvo: AppState['messagesByConvo']
}) {
  useClampMessageCursor(focus, props.byConvo, props.store)
  return null
}

async function cursorAfterArrival(scrollOnNewMessages: boolean): Promise<number | undefined> {
  const store = createAppStore()
  store.set((s) => ({ settings: { ...s.settings, scrollOnNewMessages } }))
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  const ink = render(
    <Probe store={store} byConvo={{ 'chat:c1': [msg('a'), msg('b'), msg('c')] }} />,
    { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
  )
  await new Promise((r) => setTimeout(r, 10))
  // User scrolls up to the first message, then a new one arrives.
  store.set({ messageCursorByConvo: { 'chat:c1': 0 } })
  ink.rerender(
    <Probe store={store} byConvo={{ 'chat:c1': [msg('a'), msg('b'), msg('c'), msg('d')] }} />,
  )
  await new Promise((r) => setTimeout(r, 10))
  ink.unmount()
  return store.get().messageCursorByConvo['chat:c1']
}

test('a new message moves the cursor to it when scrollOnNewMessages is on', async () => {
  expect(await cursorAfterArrival(true)).toBe(3)
})

test('the cursor stays put when scrollOnNewMessages is off', async () => {
  expect(await cursorAfterArrival(false)).toBe(0)
})
