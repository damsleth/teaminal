import { expect, test } from 'bun:test'
import { Box, renderToString } from 'ink'
import { createAppStore } from '../state/store'
import type { ChatMessage } from '../types'
import { accountRef } from '../account'
import { createGraphClient } from '../graph/client'
import { MessagePane } from './MessagePane'
import { SessionProvider, type SessionApi } from './SessionContext'
import { StoreProvider } from './StoreContext'

// Real Ink/Yoga renders of the pane, so layout regressions show up as the
// characters a terminal would actually get.

const session: SessionApi = {
  getActiveProfile: () => null,
  switchAccount: async () => {},
  client: () =>
    createGraphClient({ account: accountRef(null), audience: 'graph', fallback: false }),
}

const msg = (id: string, at: string, name: string, text: string): ChatMessage => ({
  id,
  createdDateTime: at,
  messageType: 'message',
  body: { contentType: 'text', content: text },
  from: { user: { id: `u-${name}`, displayName: name } },
})

// Two days of messages so the timeline carries day headers between groups.
const MESSAGES: ChatMessage[] = [
  msg('m1', '2026-01-01T09:00:00Z', 'Ada', 'first day, first message'),
  msg('m2', '2026-01-01T09:05:00Z', 'Bob', 'first day, second message'),
  msg('m3', '2026-01-02T09:00:00Z', 'Ada', 'second day, first message'),
  msg('m4', '2026-01-02T09:05:00Z', 'Bob', 'second day, second message'),
  msg('m5', '2026-01-03T09:00:00Z', 'Ada', 'third day, first message'),
  msg('m6', '2026-01-03T09:05:00Z', 'Bob', 'third day, newest message'),
]

function render(
  paneHeight: number,
  focusedMessageId: string | null = null,
  search: string | null = null,
  focusBackground: string | null = null,
  bgPadX = 0,
): string {
  const store = createAppStore()
  store.set({
    settings: {
      ...store.get().settings,
      messageFocusBackgroundColor: focusBackground,
      themeOverrides: { layout: { textBackgroundPaddingX: bgPadX } },
    },
    focus: { kind: 'chat', chatId: 'c1' },
    messagesByConvo: { 'chat:c1': MESSAGES },
    ...(search !== null
      ? { inputZone: 'message-search' as const, messageSearchQuery: search }
      : {}),
  })
  const out = renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <Box flexDirection="column" height={paneHeight}>
          <MessagePane focusedMessageId={focusedMessageId} focusIndicatorActive />
        </Box>
      </SessionProvider>
    </StoreProvider>,
    { columns: 80 },
  )
  return out
}

function lines(
  paneHeight: number,
  focusedMessageId: string | null = null,
  search: string | null = null,
): string[] {
  // eslint-disable-next-line no-control-regex
  return render(paneHeight, focusedMessageId, search)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
}

test('the focus background colors the message body, not the focus marker', () => {
  const raw = render(40, 'm4', null, '#ff0000').split('\n')
  const body = raw.find((l) => l.includes('second day, second message'))!
  const bg = body.indexOf('48;2;255;0;0')
  expect(bg).toBeGreaterThan(-1)
  expect(body.indexOf('>')).toBeLessThan(bg)
})

test('text background padding paints bg columns around the body', () => {
  const body = render(40, 'm4', null, '#ff0000', 2)
    .split('\n')
    .find((l) => l.includes('second day, second message'))!
  // Two red cells, then the text.
  // eslint-disable-next-line no-control-regex
  expect(body).toMatch(/48;2;255;0;0m(\x1b\[[0-9;]*m)*  (\x1b\[[0-9;]*m)*second day/)
})

test('focusedBold off leaves the focused message body unbolded', () => {
  const bodyLine = (focusedBold: boolean) => {
    const store = createAppStore()
    store.set({
      settings: { ...store.get().settings, themeOverrides: { emphasis: { focusedBold } } },
      focus: { kind: 'chat', chatId: 'c1' },
      messagesByConvo: { 'chat:c1': MESSAGES },
    })
    return renderToString(
      <StoreProvider store={store}>
        <SessionProvider api={session}>
          <Box flexDirection="column" height={40}>
            <MessagePane focusedMessageId="m4" focusIndicatorActive />
          </Box>
        </SessionProvider>
      </StoreProvider>,
      { columns: 80 },
    )
      .split('\n')
      .find((l) => l.includes('second day, second message'))!
  }
  expect(bodyLine(true)).toMatch(/\x1b\[1m[^\n]*second day/)
  expect(bodyLine(false)).not.toMatch(/\x1b\[1m[^\n]*second day/)
})

test('date marker theme settings drive its color, bold and indent', () => {
  const store = createAppStore()
  store.set({
    settings: {
      ...store.get().settings,
      themeOverrides: {
        dateMarker: '#ff0000',
        emphasis: { dateMarkerBold: false },
        layout: { dateMarkerIndent: 4 },
      },
    },
    focus: { kind: 'chat', chatId: 'c1' },
    messagesByConvo: { 'chat:c1': MESSAGES },
  })
  const out = renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <Box flexDirection="column" height={40}>
          <MessagePane />
        </Box>
      </SessionProvider>
    </StoreProvider>,
    { columns: 80 },
  )
  const marker = out.split('\n').find((l) => l.includes('Jan 2'))!
  expect(marker).toContain('38;2;255;0;0m')
  expect(marker).not.toMatch(/\x1b\[1m/)
  expect(marker.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/^ {5}\S/)
})

test('sender name toggles and message max width', () => {
  const renderWith = (settings: Record<string, unknown>, maxWidth = 100) => {
    const store = createAppStore()
    store.set({
      me: { id: 'u-Ada', displayName: 'Ada' } as never,
      settings: {
        ...store.get().settings,
        showTimestampsInPane: false,
        ...settings,
        themeOverrides: { layout: { messageMaxWidth: maxWidth } },
      },
      focus: { kind: 'chat', chatId: 'c1' },
      messagesByConvo: {
        'chat:c1': [
          ...MESSAGES,
          msg('m7', '2026-01-03T09:10:00Z', 'Bob', 'word '.repeat(30).trim()),
        ],
      },
    })
    return renderToString(
      <StoreProvider store={store}>
        <SessionProvider api={session}>
          <Box flexDirection="column" height={60}>
            <MessagePane />
          </Box>
        </SessionProvider>
      </StoreProvider>,
      { columns: 80 },
    ).replace(/\x1b\[[0-9;]*m/g, '')
  }
  const all = renderWith({})
  expect(all).toContain('Ada')
  expect(all).toContain('Bob')
  const noOwn = renderWith({ showOwnNameInPane: false })
  expect(noOwn).not.toContain('Ada')
  expect(noOwn).toContain('Bob')
  const none = renderWith({ showSenderNamesInPane: false })
  expect(none).not.toMatch(/Ada|Bob/)
  // No header line left: the body sits right under the date marker.
  expect(none).toMatch(/Jan 3\s*\n\s+.?\s*third day, first message/)
  const widest = (out: string) =>
    Math.max(
      ...out
        .split('\n')
        .filter((l) => l.includes('word'))
        .map((l) => l.trimEnd().length),
    )
  expect(widest(renderWith({}, 50))).toBeLessThanOrEqual(42)
  expect(widest(renderWith({}))).toBeGreaterThan(60)
})

test('the focus marker sits on the message body line, not the sender name', () => {
  const out = lines(40, 'm4')
  const body = out.find((l) => l.includes('second day, second message'))!
  const nameIdx = out.indexOf(body) - 1
  expect(body.trimStart().startsWith('>')).toBe(true)
  expect(out[nameIdx]).toContain('Bob')
  expect(out[nameIdx]).not.toContain('>')
})

test('an overflowing pane clips whole rows at the top instead of overlapping them', () => {
  // Timeline lines only: the pane's own chat-title header stays pinned above.
  const timeline = (h: number) => lines(h).filter((l) => l.trim() !== '' && !l.includes('chat c1'))
  const full = timeline(40)
  // Far shorter than the row window the pane sizes itself for.
  const clipped = timeline(8)
  // Every visible line is intact and in order: a contiguous tail of the
  // unclipped timeline, ending at the newest message. Shrunk rows would
  // drop or overdraw lines (a day header painted over by a sender name).
  expect(clipped.length).toBeGreaterThan(0)
  expect(full.slice(full.length - clipped.length)).toEqual(clipped)
  expect(clipped.at(-1)).toContain('third day, newest message')
})

test('an HTML body keeps its line breaks, bullets and bold run', () => {
  const store = createAppStore()
  store.set({
    focus: { kind: 'chat', chatId: 'c1' },
    messagesByConvo: {
      'chat:c1': [
        {
          ...msg('h1', '2026-01-01T09:00:00Z', 'Ada', ''),
          body: {
            contentType: 'html',
            content: '<p>git clone</p><p>cd <strong>SKILLS</strong></p><ul><li>one</li></ul>',
          },
        },
      ],
    },
  })
  const raw = renderToString(
    <StoreProvider store={store}>
      <SessionProvider api={session}>
        <Box flexDirection="column" height={20}>
          <MessagePane focusedMessageId={null} />
        </Box>
      </SessionProvider>
    </StoreProvider>,
    { columns: 80 },
  )
  // eslint-disable-next-line no-control-regex
  const out = raw.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  const at = out.findIndex((l) => l.includes('git clone'))
  expect(out[at + 1]).toContain('cd SKILLS')
  expect(out[at + 2]).toContain('• one')
  expect(raw).toMatch(/\x1b\[1mSKILLS/)
})

test('the search bar stays intact above an overflowing timeline', () => {
  const out = lines(8, null, 'newest')
  expect(out.filter((l) => l.includes('hit(s)'))).toHaveLength(1)
  expect(out.filter((l) => l.trim() !== '').at(-1)).toContain('third day, newest message')
})
