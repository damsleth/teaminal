import { expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { accountStore, openAccount } from '../state/accountStore'
import { applySeededState } from '../state/seedFixtures'
import { createAppStore } from '../state/store'
import { ChatList } from './ChatList'
import { StoreProvider } from './StoreContext'
import { SessionProvider, type SessionApi } from './SessionContext'
import { accountRef } from '../account'
import { createGraphClient } from '../graph/client'

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

function render(theme: 'light' | 'dark', cursor: number): string[] {
  const store = createAppStore(accountRef(null))
  applySeededState(accountStore(store))
  const s = store.get()
  store.set({
    settings: {
      ...s.settings,
      theme,
      chatListGroupByType: true,
      chatListCollapsedSections: { oneOnOne: true, group: true },
    },
    cursor,
  })
  return renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <ChatList listPaneWidth={34} />
      </SessionProvider>
    </StoreProvider>,
    { columns: 34 },
  ).split('\n')
}

// Section headers are bold at rest, so a foreground change alone left the
// focused one indistinguishable (and ANSI blue unreadable on dark terminals).
// The focused header is padded out to a full-width background bar; assert on
// the padding so the check holds at any color level >= 1 (with color off Ink
// trims the trailing spaces; src/test-preload.ts keeps color on under CI).
for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: only the focused section header renders a full-width bar`, () => {
    // eslint-disable-next-line no-control-regex
    const [direct, groups] = render(theme, 1).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
    expect(direct).toBe('▸ Direct (1)')
    // 34-col pane minus border (2) and right gutter (1).
    expect(groups).toBe('▸ Groups (2)'.padEnd(31))
  })
}

test('thumbnails: a picture column on chat rows, rows at least as tall as the picture', () => {
  const prev = process.env.KITTY_WINDOW_ID
  process.env.KITTY_WINDOW_ID = '1'
  try {
    const renderList = (chatListThumbnails: string, chatListPresenceStyle = 'dot') => {
      const store = createAppStore(accountRef(null))
      applySeededState(accountStore(store))
      store.set({
        settings: {
          ...store.get().settings,
          chatListThumbnails,
          chatListPresenceStyle,
        } as never,
        cursor: 0,
      })
      return renderToString(
        <StoreProvider store={store}>
          <SessionProvider api={session}>
            <ChatList listPaneWidth={40} />
          </SessionProvider>
        </StoreProvider>,
        { columns: 40 },
      )
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split('\n')
    }
    const off = renderList('off')
    const medium = renderList('medium') // 2 rows x 4 cols + 1 gap column
    const at = (ls: string[], text: string) => ls.findIndex((l) => l.includes(text))
    const col = (ls: string[], text: string) => ls[at(ls, text)]!.indexOf(text)
    expect(col(medium, 'Ada Byron') - col(off, 'Ada Byron')).toBe(5)
    // Each chat row is at least 2 rows tall, so the next row starts lower.
    expect(at(medium, 'Design Sync') - at(medium, 'Ada Byron')).toBeGreaterThanOrEqual(2)
    // The group's type glyph (U+F0C0) moves into the picture: not repeated.
    expect(off[at(off, 'Design Sync')]).toContain('\uf0c0')
    expect(medium[at(medium, 'Design Sync')]).not.toContain('\uf0c0')
    // Presence on the picture: the text dot and its gutter go, so names
    // move left by the gutter (2 glyph cols + chatListIndent 1).
    expect(medium[at(medium, 'Ada Byron')]).toContain('◯')
    const badge = renderList('medium', 'badge')
    expect(badge[at(badge, 'Ada Byron')]).not.toContain('◯')
    expect(col(medium, 'Ada Byron') - col(badge, 'Ada Byron')).toBe(3)
  } finally {
    if (prev === undefined) delete process.env.KITTY_WINDOW_ID
    else process.env.KITTY_WINDOW_ID = prev
  }
})

test('chatListPreviewText colors the previews of read chats', () => {
  const store = createAppStore(accountRef(null))
  applySeededState(accountStore(store))
  store.set({
    settings: { ...store.get().settings, themeOverrides: { chatListPreviewText: '#ff0000' } },
    unreadByChatId: {},
  })
  const out = renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <ChatList listPaneWidth={40} />
      </SessionProvider>
    </StoreProvider>,
    { columns: 40 },
  )
  const preview = out.split('\n').find((l) => l.includes('The launch notes'))!
  expect(preview).toContain('38;2;255;0;0m')
  // 1:1 previews skip the sender name; the row already names them.
  expect(preview).not.toContain('Ada')
})

test('the selected row is colored as a whole and can be framed', () => {
  const renderList = (overrides: object) => {
    const store = createAppStore(accountRef(null))
    applySeededState(accountStore(store))
    store.set({
      settings: { ...store.get().settings, themeOverrides: overrides } as never,
      cursor: 0,
    })
    return renderToString(
      <StoreProvider store={store}>
        <SessionProvider api={session}>
          <ChatList listPaneWidth={40} />
        </SessionProvider>
      </StoreProvider>,
      { columns: 40 },
    ).split('\n')
  }
  const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, '')
  const at = (ls: string[], text: string) => ls.findIndex((l) => plain(l).includes(text))
  // Background on the preview line of the selected chat too.
  const bg = renderList({ selectedRowBackground: '#ff0000' })
  expect(bg[at(bg, 'The launch notes')]).toContain('48;2;255;0;0m')
  // A selected-row border frames the selected row only, and every row
  // reserves the frame (2 rows), so rows sit further apart.
  const framed = renderList({ borders: { selectedRow: 'single' } }).map(plain)
  const flat = renderList({}).map(plain)
  expect(framed[at(framed, 'Ada Byron') - 1]).toContain('┌')
  expect(framed.filter((l) => l.includes('┌'))).toHaveLength(1)
  expect(at(framed, 'Design Sync') - at(framed, 'Ada Byron')).toBe(
    at(flat, 'Design Sync') - at(flat, 'Ada Byron') + 2,
  )
})

test('no account open (every account removed): an empty state, not loading', () => {
  const store = createAppStore()
  const out = renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <ChatList listPaneWidth={60} />
      </SessionProvider>
    </StoreProvider>,
    { columns: 60 },
  )
  expect(out).toContain('no account')
  expect(out).not.toContain('loading')
})

test('unified sidebar: each row reads its own account’s unread mark; headers carry counts', () => {
  const store = createAppStore()
  applySeededState(openAccount(store, accountRef('alpha'), { foreground: true }), 'alpha')
  const beta = openAccount(store, accountRef('beta'), { foreground: false })
  applySeededState(beta, 'beta')
  const chatId = store.get().chats[0]!.id
  // Unread in beta only, on a chat id alpha has too.
  beta.set({ unreadByChatId: { [chatId]: { unreadCount: 2, mentionCount: 1 } } })
  store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha', 'beta'] } }))
  const lines = renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <ChatList listPaneWidth={40} />
      </SessionProvider>
    </StoreProvider>,
    { columns: 40 },
  )
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
  expect(lines[0]).toStartWith('▾ alpha · example.com')
  const betaHeader = lines.find((l) => l.startsWith('▾ beta'))!
  // 1 chat with unread activity (mentions count the activity feed's).
  expect(betaHeader).toStartWith('▾ beta 1 · example.com')
  expect(lines.find((l) => l.includes('Ada Byron'))).not.toContain('@')
  expect(lines.find((l) => l.includes('ADA BYRON'))).toContain(' @')
})
