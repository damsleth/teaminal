import { expect, test } from 'bun:test'
import { Box, renderToString } from 'ink'
import { createAppStore } from '../state/store'
import { HeaderBar } from './HeaderBar'
import { StoreProvider } from './StoreContext'
import { SessionProvider, type SessionApi } from './SessionContext'
import { accountRef } from '../account'
import { createGraphClient } from '../graph/client'

const session: SessionApi = {
  getActiveProfile: () => null,
  switchAccount: async () => {},
  client: () =>
    createGraphClient({ account: accountRef(null), audience: 'graph', fallback: false }),
}

// The bar sits in a bordered row box (App.tsx); centering must use its width.
const render = (headerBarCentered: boolean) => {
  const store = createAppStore()
  store.set({ settings: { ...store.get().settings, headerBarCentered } })
  return renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <Box borderStyle="round" paddingX={1}>
          <HeaderBar />
        </Box>
      </SessionProvider>
    </StoreProvider>,
    { columns: 100 },
  ).replace(/\x1b\[[0-9;]*m/g, '')
}

test('headerBarCentered centers the header text', () => {
  const indent = (out: string) => out.split('\n')[1]!.slice(1).search(/\S/)
  expect(indent(render(false))).toBeLessThan(4)
  expect(indent(render(true))).toBeGreaterThan(10)
})
