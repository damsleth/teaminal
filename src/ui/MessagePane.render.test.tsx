import { expect, test } from 'bun:test'
import { Box, renderToString } from 'ink'
import { createAppStore } from '../state/store'
import type { ChatMessage } from '../types'
import { MessagePane } from './MessagePane'
import { StoreProvider } from './StoreContext'

// Real Ink/Yoga renders of the pane, so layout regressions show up as the
// characters a terminal would actually get.

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

function lines(
  paneHeight: number,
  focusedMessageId: string | null = null,
  search: string | null = null,
): string[] {
  const store = createAppStore()
  store.set({
    focus: { kind: 'chat', chatId: 'c1' },
    messagesByConvo: { 'chat:c1': MESSAGES },
    ...(search !== null
      ? { inputZone: 'message-search' as const, messageSearchQuery: search }
      : {}),
  })
  const out = renderToString(
    <StoreProvider store={store}>
      <Box flexDirection="column" height={paneHeight}>
        <MessagePane focusedMessageId={focusedMessageId} focusIndicatorActive />
      </Box>
    </StoreProvider>,
    { columns: 80 },
  )
  // eslint-disable-next-line no-control-regex
  return out.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
}

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
