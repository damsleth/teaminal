import { expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { applySeededState } from '../state/seedFixtures'
import { createAppStore } from '../state/store'
import { ChatList } from './ChatList'
import { StoreProvider } from './StoreContext'

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
      <ChatList listPaneWidth={34} />
    </StoreProvider>,
    { columns: 34 },
  ).split('\n')
}

// Section headers are bold at rest, so a foreground change alone left the
// focused one indistinguishable (and ANSI blue unreadable on dark terminals).
// The focused header is padded out to a full-width background bar; assert on
// the padding so the check holds at any color level >= 1 (with color off Ink
// trims the trailing spaces, and there is no bar to see anyway).
for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: only the focused section header renders a full-width bar`, () => {
    // eslint-disable-next-line no-control-regex
    const [direct, groups] = render(theme, 1).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
    expect(direct).toBe('▸ Direct (1)')
    // 34-col pane minus border (2) and right gutter (1).
    expect(groups).toBe('▸ Groups (2)'.padEnd(31))
  })
}
