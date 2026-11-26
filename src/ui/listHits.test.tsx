// Click hit-testing against a real Yoga layout: ChatList inside a bordered,
// offset pane, rendered by Ink to a fake terminal. Expected cells come from
// the painted frame, not from the row-height arithmetic.

import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { Box, render } from 'ink'
import { accountRef } from '../account'
import { createGraphClient } from '../graph/client'
import { accountStore, openAccount } from '../state/accountStore'
import { applySeededState } from '../state/seedFixtures'
import { accountRowKey } from '../state/selectables'
import { createAppStore, type AppState, type Store } from '../state/store'
import type { Chat } from '../types'
import { ChatList } from './ChatList'
import { listRowKeyAt } from './listHits'
import { SessionProvider, type SessionApi } from './SessionContext'
import { StoreProvider } from './StoreContext'

const session: SessionApi = {
  getActiveProfile: () => null,
  switchAccount: async () => {},
  retryRealtime: () => {},
  reconcile: async () => {},
  setForeground: () => {},
  retry: async () => {},
  running: () => [],
  clientFor: () => {
    throw new Error('unused')
  },
  client: () =>
    createGraphClient({ account: accountRef(null), audience: 'graph', fallback: false }),
}

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

// column: the pane stacks its content, so the list box is as tall as its
// rows and can run past the pane (App's pane stretches it to fit instead).
type Pane = { top: number; left: number; width: number; height: number; column?: boolean }

function mount(store: Store<AppState>, pane: Pane) {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  stdout.columns = 100
  stdout.rows = 30
  let frame = ''
  stdout.on('data', (d: Buffer) => (frame = plain(d.toString())))
  const tree = (p: Pane) => (
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <Box flexDirection="column" height={30}>
          <Box height={p.top} flexShrink={0} />
          <Box flexDirection="row" flexShrink={0}>
            <Box width={p.left} flexShrink={0} />
            <Box
              width={p.width}
              height={p.height}
              flexShrink={0}
              flexDirection={p.column ? 'column' : 'row'}
              borderStyle="round"
            >
              <ChatList listPaneWidth={p.width} />
            </Box>
          </Box>
        </Box>
      </SessionProvider>
    </StoreProvider>
  )
  const app = render(tree(pane), {
    stdout,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  const lines = () => frame.split('\n')
  // First screen row whose text contains `text`.
  const rowOf = (text: string) => {
    const y = lines().findIndex((l) => l.includes(text))
    if (y < 0) throw new Error(`"${text}" not painted:\n${frame}`)
    return y
  }
  return {
    app,
    lines,
    rowOf,
    flush: () => app.waitUntilRenderFlush(),
    rerender: (p: Pane) => app.rerender(tree(p)),
  }
}

function seeded(patch: (s: AppState) => Partial<AppState> = () => ({})) {
  const store = createAppStore(accountRef(null))
  applySeededState(accountStore(store))
  store.set((s) => patch(s))
  return store
}

const DESIGN = 'chat:seed-chat-design-sync'
const OPS = 'chat:seed-chat-ops'

test('every line of a wrapped name and a two-line preview hits its row; gaps and chrome do not', async () => {
  const store = seeded((s) => ({
    chats: s.chats.map((c) =>
      c.id === 'seed-chat-design-sync'
        ? { ...c, topic: 'Design Sync for the quarterly roadmap review' }
        : c,
    ),
    settings: {
      ...s.settings,
      chatListPreviewLines: 2,
      themeOverrides: { layout: { chatListGap: 1 } },
    },
  }))
  const pane = { top: 2, left: 3, width: 30, height: 20 }
  const m = mount(store, pane)
  try {
    await m.flush()
    const design = m.rowOf('Design Sync for')
    const ops = m.rowOf('Ops Channel')
    // Name on two lines, preview on two: four lines, then the gap row.
    expect(ops - design).toBe(5)
    const x = pane.left + 2
    for (let y = design; y < design + 4; y++) expect(listRowKeyAt(x, y)).toBe(DESIGN)
    expect(listRowKeyAt(x, design + 4)).toBeNull()
    expect(listRowKeyAt(x, ops)).toBe(OPS)
    // The right edge of the row's text still hits; the pane border does not.
    expect(listRowKeyAt(pane.left + pane.width - 3, design)).toBe(DESIGN)
    expect(listRowKeyAt(pane.left + pane.width - 1, design)).toBeNull()
    expect(listRowKeyAt(pane.left, design)).toBeNull()
    // Left of the pane, its top border, and the empty space below the list.
    expect(listRowKeyAt(pane.left - 1, design)).toBeNull()
    expect(listRowKeyAt(x, pane.top)).toBeNull()
    expect(listRowKeyAt(x, pane.top + pane.height - 3)).toBeNull()
  } finally {
    m.app.unmount()
  }
})

test('two accounts: the gap above an account header hits nothing, header and rows hit their keys', async () => {
  const store = createAppStore()
  applySeededState(openAccount(store, accountRef('alpha'), { foreground: true }), 'alpha')
  applySeededState(openAccount(store, accountRef('beta'), { foreground: false }), 'beta')
  store.set((s) => ({
    settings: {
      ...s.settings,
      accounts: ['alpha', 'beta'],
      themeOverrides: { layout: { accountGap: 1 } },
    },
  }))
  const beta = accountRef('beta').id
  const m = mount(store, { top: 1, left: 0, width: 40, height: 24 })
  try {
    await m.flush()
    const header = m.rowOf('▾ beta')
    expect(m.lines()[header - 1]!.slice(1, 39).trim()).toBe('')
    expect(listRowKeyAt(5, header - 1)).toBeNull()
    expect(listRowKeyAt(5, header)).toBe(accountRowKey(beta))
    expect(listRowKeyAt(5, m.rowOf('ADA BYRON'))).toBe(`${beta}/chat:seed-chat-ada`)
    expect(listRowKeyAt(5, m.rowOf('▾ alpha'))).toBe(accountRowKey(accountRef('alpha').id))
  } finally {
    m.app.unmount()
  }
})

test('the filter banner hits nothing', async () => {
  const store = seeded(() => ({ filter: 'Ops', inputZone: 'filter' }))
  const m = mount(store, { top: 0, left: 0, width: 30, height: 10 })
  try {
    await m.flush()
    expect(listRowKeyAt(2, m.rowOf('/ Ops'))).toBeNull()
    expect(listRowKeyAt(2, m.rowOf('Ops Channel'))).toBe(OPS)
  } finally {
    m.app.unmount()
  }
})

function manyChats(n: number, suffix = ''): Chat[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `many-${i}`,
    chatType: 'group',
    createdDateTime: '2026-01-01T00:00:00Z',
    topic: `Room ${String(i).padStart(2, '0')}${suffix}`,
    members: [],
  }))
}

test('a row cut off by the pane bottom hits only inside the pane', async () => {
  const store = seeded((s) => ({
    chats: manyChats(10, ' with a name long enough to wrap'),
    settings: { ...s.settings, chatListPreviewLines: 0 },
    cursor: 0,
    cursorKey: null,
  }))
  // Interior rows 2..6: two whole two-line rows, then one cut in half.
  const pane = { top: 1, left: 2, width: 30, height: 7, column: true }
  const m = mount(store, pane)
  try {
    await m.flush()
    const bottom = pane.top + pane.height - 1
    const cut = m.rowOf('Room 02')
    expect(cut).toBe(bottom - 1)
    expect(listRowKeyAt(4, cut)).toBe('chat:many-2')
    // Its second line is drawn over the border; the next row below it.
    expect(listRowKeyAt(4, bottom)).toBeNull()
    expect(listRowKeyAt(4, bottom + 1)).toBeNull()
    expect(listRowKeyAt(4, bottom + 2)).toBeNull()
  } finally {
    m.app.unmount()
  }
})

test('rows scrolled away, resized or unmounted do not hit', async () => {
  const store = seeded((s) => ({
    chats: manyChats(30),
    settings: { ...s.settings, chatListPreviewLines: 0 },
    cursor: 0,
    cursorKey: null,
  }))
  // A short pane for a list sized for a 30-row terminal.
  const pane = { top: 1, left: 2, width: 30, height: 8 }
  const m = mount(store, pane)
  try {
    await m.flush()
    const bottom = pane.top + pane.height - 1 // the pane's bottom border row
    expect(listRowKeyAt(4, m.rowOf('Room 00'))).toBe('chat:many-0')
    const last = m.rowOf('Room 05')
    expect(last).toBe(bottom - 1)
    expect(listRowKeyAt(4, last)).toBe('chat:many-5')
    expect(listRowKeyAt(4, bottom)).toBeNull()
    expect(listRowKeyAt(4, bottom + 1)).toBeNull()

    // Scroll: the cursor far down moves the viewport; rows above are gone.
    store.set({ cursor: 25, cursorKey: 'chat:many-25' })
    await m.flush()
    const hits = new Set<string>()
    for (let y = 0; y < 30; y++) {
      const key = listRowKeyAt(4, y)
      if (key) hits.add(key)
    }
    expect(hits.has('chat:many-0')).toBe(false)
    const first = m.lines().findIndex((l) => /Room \d\d/.test(l))
    const room = m.lines()[first]!.match(/Room (\d\d)/)![1]!
    expect(Number(room)).toBeGreaterThan(0)
    expect(listRowKeyAt(4, first)).toBe(`chat:many-${Number(room)}`)

    // Resize: a taller, narrower pane moved right.
    const wide = { top: 3, left: 10, width: 24, height: 12 }
    m.rerender(wide)
    await m.flush()
    const y = m.lines().findIndex((l) => /Room \d\d/.test(l))
    const n = Number(m.lines()[y]!.match(/Room (\d\d)/)![1])
    expect(listRowKeyAt(wide.left + 2, y)).toBe(`chat:many-${n}`)
    expect(listRowKeyAt(pane.left + 2, y)).toBeNull()
  } finally {
    m.app.unmount()
  }
  // Unmounted: nothing hits anywhere.
  for (let y = 0; y < 30; y++) expect(listRowKeyAt(4, y)).toBeNull()
})
