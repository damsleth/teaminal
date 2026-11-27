import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { Box, render } from 'ink'
import { accountRef } from '../account'
import { accountStore } from '../state/accountStore'
import { applySeededState } from '../state/seedFixtures'
import { createAppStore, type AppState, type Store } from '../state/store'
import { followTabs, type TabView } from '../state/tabs'
import { tabIndexAt } from './listHits'
import { layoutTabBar, TabBar, type TabSegment } from './TabBar'
import { StoreProvider } from './StoreContext'

const view = (label: string, unread: TabView['unread'] = null): TabView => ({ label, unread })

// The bar as painted (no colors).
function paint(segments: TabSegment[]): string {
  return segments
    .map((s) => (s.kind === 'sep' ? '│' : s.kind === 'more' ? s.text : `${s.text}${s.marker} `))
    .join('')
}

const shown = (segments: TabSegment[]) =>
  segments.flatMap((s) => (s.kind === 'tab' ? [s.index] : []))

describe('layoutTabBar', () => {
  const three = [view('Ada Byron'), view('Design Sync', 'unread'), view('#launch')]

  test('everything fits: numbered tabs, separators, the unread marker', () => {
    expect(paint(layoutTabBar(three, 0, 80))).toBe(' 1 Ada Byron │ 2 Design Sync ● │ 3 #launch ')
    expect(paint(layoutTabBar([view('Ada', 'mention')], 0, 80))).toBe(' 1 Ada @ ')
  })

  test('tabs past the ninth carry no number', () => {
    const many = Array.from({ length: 11 }, (_, i) => view(`T${i + 1}`))
    const bar = paint(layoutTabBar(many, 0, 200))
    expect(bar).toContain(' 9 T9 │ T10 │ T11 ')
  })

  test('too narrow: the active tab stays in view, ‹ › mark the hidden ones', () => {
    // ' 1 Ada Byron ' is 13 cells, ' 2 Design Sync ● ' 17, ' 3 #launch ' 11.
    const mid = layoutTabBar(three, 1, 20)
    expect(shown(mid)).toEqual([1])
    expect(paint(mid)).toBe('‹ 2 Design Sync ● ›')
    const last = layoutTabBar(three, 2, 32)
    expect(shown(last)).toEqual([1, 2])
    expect(paint(last)).toBe('‹ 2 Design Sync ● │ 3 #launch ')
    const first = layoutTabBar(three, 0, 32)
    expect(shown(first)).toEqual([0, 1])
    expect(paint(first).endsWith('›')).toBe(true)
  })

  test('the bar never runs past its width', () => {
    for (let width = 1; width <= 50; width++) {
      for (const active of [0, 1, 2]) {
        const segs = layoutTabBar(three, active, width)
        expect(shown(segs)).toContain(active)
        expect(Bun.stringWidth(paint(segs))).toBeLessThanOrEqual(Math.max(width, 2))
      }
    }
  })

  test('a long or wide-character label is cut by terminal cells', () => {
    const wide = [view('東京オフィスの定例ミーティングとその他のお知らせ'), view('Bob')]
    const bar = paint(layoutTabBar(wide, 0, 200))
    // Capped at 24 cells, ending in an ellipsis, never splitting a character.
    expect(bar.startsWith(' 1 東京オフィスの定例ミー… │')).toBe(true)
    expect(Bun.stringWidth(bar.split('│')[0]!)).toBeLessThanOrEqual(2 + 2 + 24)
    // Narrower than the active tab alone: its label is cut further.
    const tight = paint(layoutTabBar(wide, 0, 12))
    expect(Bun.stringWidth(tight)).toBeLessThanOrEqual(12)
    expect(tight.startsWith(' 1 ')).toBe(true)
  })

  test('no tabs, or no room, is no bar', () => {
    expect(layoutTabBar([], 0, 80)).toEqual([])
    expect(layoutTabBar(three, 0, 0)).toEqual([])
  })
})

describe('TabBar', () => {
  function mount(store: Store<AppState>, width: number) {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream
    stdout.columns = 100
    stdout.rows = 10
    let frame = ''
    // eslint-disable-next-line no-control-regex
    stdout.on('data', (d: Buffer) => (frame = d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')))
    const app = render(
      <StoreProvider store={store}>
        <Box flexDirection="column">
          <Box height={2} flexShrink={0} />
          <Box flexDirection="row">
            <Box width={5} flexShrink={0} />
            <TabBar width={width} />
          </Box>
        </Box>
      </StoreProvider>,
      {
        stdout,
        stdin: new PassThrough() as unknown as NodeJS.ReadStream,
        stderr: new PassThrough() as unknown as NodeJS.WriteStream,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    return { app, frame: () => frame }
  }

  function seeded(mode: 'single' | 'tabs') {
    const store = createAppStore(accountRef('alpha'))
    applySeededState(accountStore(store), 'alpha')
    store.set((s) => ({ settings: { ...s.settings, conversationMode: 'tabs' } }))
    followTabs(store)
    for (const id of ['seed-chat-ada', 'seed-chat-design-sync', 'seed-chat-ops']) {
      store.set({ focus: { kind: 'chat', chatId: id } })
    }
    store.set((s) => ({ settings: { ...s.settings, conversationMode: mode } }))
    return store
  }

  test('single mode draws nothing, even with tabs kept', async () => {
    const m = mount(seeded('single'), 60)
    try {
      await m.app.waitUntilRenderFlush()
      expect(m.frame().trim()).toBe('')
      expect(tabIndexAt(8, 2)).toBeNull()
    } finally {
      m.app.unmount()
    }
  })

  test('tabs mode draws the bar; a click on a tab hits its index', async () => {
    const m = mount(seeded('tabs'), 60)
    try {
      await m.app.waitUntilRenderFlush()
      const line = m.frame().split('\n')[2]!
      expect(line).toContain(' 1 Ada Byron │ 2 Design Sync │ 3 Ops Channel ')
      const x = (text: string) => line.indexOf(text)
      expect(tabIndexAt(x('Ada'), 2)).toBe(0)
      expect(tabIndexAt(x('Design'), 2)).toBe(1)
      expect(tabIndexAt(x('Ops'), 2)).toBe(2)
      // The separator, the row above and the margin left of the bar hit nothing.
      expect(tabIndexAt(x('│'), 2)).toBeNull()
      expect(tabIndexAt(x('Ada'), 1)).toBeNull()
      expect(tabIndexAt(2, 2)).toBeNull()
    } finally {
      m.app.unmount()
    }
    // Unmounted: nothing hits.
    expect(tabIndexAt(8, 2)).toBeNull()
  })
})
