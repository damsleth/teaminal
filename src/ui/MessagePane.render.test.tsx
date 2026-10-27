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
  generation: () => 0,
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

test('the search bar stays intact above an overflowing timeline', () => {
  const out = lines(8, null, 'newest')
  expect(out.filter((l) => l.includes('hit(s)'))).toHaveLength(1)
  expect(out.filter((l) => l.trim() !== '').at(-1)).toContain('third day, newest message')
})
