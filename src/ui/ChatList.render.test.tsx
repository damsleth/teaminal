import { expect, test } from 'bun:test'
import { renderToString } from 'ink'
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
  client: () =>
    createGraphClient({ account: accountRef(null), audience: 'graph', fallback: false }),
}

function render(theme: 'light' | 'dark', cursor: number): string[] {
  const store = createAppStore()
  applySeededState(store)
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
    const renderList = (chatListThumbnails: string) => {
      const store = createAppStore()
      applySeededState(store)
      store.set({
        settings: { ...store.get().settings, chatListThumbnails } as never,
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
  } finally {
    if (prev === undefined) delete process.env.KITTY_WINDOW_ID
    else process.env.KITTY_WINDOW_ID = prev
  }
})

test('chatListPreviewText colors the previews of read chats', () => {
  const store = createAppStore()
  applySeededState(store)
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
})
