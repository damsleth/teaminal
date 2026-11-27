// Deleting a chat of a background account from the unified sidebar: that
// account must not come back to the front on the deleted chat.

import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { accountRef } from '../account'
import { openAccount } from '../state/accountStore'
import { createAppStore } from '../state/store'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'
import { SessionProvider, type SessionApi } from './SessionContext'
import { StoreProvider } from './StoreContext'

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

test('y clears the saved focus of the background account that had the chat open', async () => {
  const store = createAppStore()
  openAccount(store, accountRef('alpha'), { foreground: true })
  const beta = accountRef('beta')
  store.set((s) => ({
    // beta's slot is not open, so the delete itself is skipped: no request.
    uiByAccount: {
      ...s.uiByAccount,
      [beta.id]: { focus: { kind: 'chat', chatId: 'c1' }, cursor: 3, cursorKey: null },
    },
    tabs: [{ account: beta.id, focus: { kind: 'chat', chatId: 'c1' } }],
    modal: { kind: 'confirm-delete-chat', chatId: 'c1', label: 'Bob', alias: 'beta' },
  }))
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  const app = render(
    <StoreProvider store={store}>
      <SessionProvider api={{} as SessionApi}>
        <ConfirmDeleteModal />
      </SessionProvider>
    </StoreProvider>,
    {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await tick()
  stdin.write('y')
  await tick()
  const s = store.get()
  expect(s.modal).toBeNull()
  expect(s.tabs).toEqual([])
  expect(s.uiByAccount[beta.id]).toEqual({ focus: { kind: 'list' }, cursor: 3, cursorKey: null })
  app.unmount()
})
