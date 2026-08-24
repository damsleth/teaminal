#!/usr/bin/env bun
/**
 * perf-rerender — measure re-render cost of a no-op active poll.
 *
 * Hypothesis under test: the 5s active loop rebuilds container objects
 * unconditionally, so Store.set's reference-equality check sees a change even
 * when the server returned byte-identical messages. Every useAppState
 * subscriber then re-renders, and MessagePane reconciles every MessageRow.
 *
 * This harness renders the real seeded app into a throwaway stream, then
 * replays the SAME page of messages through mergeActivePagePatch N times and
 * reports store notifications, React renders, and wall-clock.
 *
 * Usage: bun run scripts/perf-rerender.tsx [iterations]
 */

import { render } from 'ink'
import { Profiler, type ReactNode } from 'react'
import { Writable, Readable } from 'node:stream'

import { App } from '../src/ui/App'
import { ErrorBoundary } from '../src/ui/ErrorBoundary'
import { StoreProvider } from '../src/ui/StoreContext'
import { PollerProvider } from '../src/ui/PollerContext'
import { SessionProvider, type SessionApi } from '../src/ui/SessionContext'
import { createAppStore } from '../src/state/store'
import { applySeededState } from '../src/state/seedFixtures'
import { mergeActivePagePatch } from '../src/state/poller/pagePatch'
import type { ConvKey } from '../src/state/store'

const ITERATIONS = Number(process.argv[2] ?? 20)
/** Pad the focused conversation to this many messages, to mimic a real chat. */
const MESSAGE_COUNT = Number(process.argv[3] ?? 60)

// ---------------------------------------------------------------------------
// A stdout that swallows everything but still looks like a TTY to Ink, so the
// render path (including ANSI generation) runs for real.
// ---------------------------------------------------------------------------
class NullTty extends Writable {
  columns = 120
  rows = 40
  isTTY = true
  bytes = 0
  override _write(chunk: Buffer | string, _enc: unknown, cb: () => void) {
    this.bytes += chunk.length
    cb()
  }
}

const stdout = new NullTty()

// A stdin that claims raw-mode support, so useInput mounts instead of tripping
// the ErrorBoundary. Never emits data.
class FakeTty extends Readable {
  isTTY = true
  override _read() {}
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

const stdin = new FakeTty()

// ---------------------------------------------------------------------------
// Store + seeded state
// ---------------------------------------------------------------------------
const store = createAppStore()
applySeededState(store)

let notifications = 0
store.subscribe(() => {
  notifications++
})

// Pick the conversation with the most messages and focus it, so MessagePane
// renders a realistic row count.
const state = store.get()
const convs = Object.entries(state.messageCacheByConvo) as [ConvKey, { messages: unknown[] }][]
const [conv] = convs.sort((a, b) => b[1].messages.length - a[1].messages.length)[0] ?? []
if (!conv) {
  console.error('no seeded conversation found')
  process.exit(1)
}
const seedMessages = store.get().messageCacheByConvo[conv]?.messages ?? []

// Pad to MESSAGE_COUNT by cloning the seed messages with fresh ids/timestamps,
// so MessagePane renders a screenful of rows like it would in a real chat.
const messages = [...seedMessages]
const base = Date.parse(seedMessages[0]?.createdDateTime ?? '2026-01-01T00:00:00Z')
for (let i = messages.length; i < MESSAGE_COUNT; i++) {
  const src = seedMessages[i % seedMessages.length]
  if (!src) break
  messages.push({
    ...src,
    id: `perf-${i}`,
    createdDateTime: new Date(base + i * 60_000).toISOString(),
  })
}
messages.sort((a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime))

const chatId = conv.startsWith('chat:') ? conv.slice('chat:'.length) : undefined
if (chatId) store.set({ focus: { kind: 'chat', chatId } })
// Seat the padded conversation in the store before the first render.
store.set((s) => ({
  messageCacheByConvo: {
    ...s.messageCacheByConvo,
    [conv]: { ...s.messageCacheByConvo[conv]!, messages },
  },
  messagesByConvo: { ...s.messagesByConvo, [conv]: messages },
}))

console.log(`conv=${conv} messages=${messages.length} iterations=${ITERATIONS}`)

// ---------------------------------------------------------------------------
// Render the real tree, counting React commits via Profiler
// ---------------------------------------------------------------------------
let commits = 0
let reactMs = 0

const noopSession: SessionApi = new Proxy({} as SessionApi, {
  get: () => () => Promise.resolve(undefined),
})

function Tree(props: { children?: ReactNode }) {
  return (
    <Profiler
      id="app"
      onRender={(_id, _phase, actualDuration) => {
        commits++
        reactMs += actualDuration
      }}
    >
      {props.children}
    </Profiler>
  )
}

const ink = render(
  <ErrorBoundary>
    <StoreProvider store={store}>
      <PollerProvider handleRef={{ current: null }}>
        <SessionProvider api={noopSession}>
          <Tree>
            <App />
          </Tree>
        </SessionProvider>
      </PollerProvider>
    </StoreProvider>
  </ErrorBoundary>,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    maxFps: 60,
    patchConsole: false,
    exitOnCtrlC: false,
  },
)

// Let the first paint settle.
await new Promise((r) => setTimeout(r, 500))

const baseCommits = commits
const baseNotifications = notifications
const baseBytes = stdout.bytes
reactMs = 0

// ---------------------------------------------------------------------------
// Replay the SAME page N times — a no-op poll, semantically
// ---------------------------------------------------------------------------
const page = { messages: [...messages], nextLink: undefined }
const focus = store.get().focus

const t0 = performance.now()
for (let i = 0; i < ITERATIONS; i++) {
  store.set((s) => ({ ...mergeActivePagePatch(s, conv, page, focus) }))
  // Give Ink a frame to actually paint, as it would in the real app.
  await new Promise((r) => setTimeout(r, 20))
}
const wall = performance.now() - t0

ink.unmount()

const noopCommits = commits - baseCommits
const noopNotifications = notifications - baseNotifications
const noopBytes = stdout.bytes - baseBytes

console.log('')
console.log('--- no-op poll replay -------------------------------')
console.log(`store notifications : ${noopNotifications}   (ideal: 0)`)
console.log(`react commits       : ${noopCommits}   (ideal: 0)`)
console.log(`react time          : ${reactMs.toFixed(1)}ms`)
console.log(`ansi bytes written  : ${noopBytes}   (ideal: 0)`)
console.log(`wall clock          : ${wall.toFixed(0)}ms for ${ITERATIONS} polls`)
console.log('')
console.log(
  `per no-op poll      : ${(reactMs / ITERATIONS).toFixed(2)}ms react, ${Math.round(noopBytes / ITERATIONS)} bytes`,
)

// NOTE: keystroke cost is deliberately NOT measured here. Ink reads input
// through its own stdin wrapper, so synthesising keys on a fake stream never
// reaches useInput (verified: 0 commits for 40 keys). Measuring the keystroke
// path needs a real pty — use the @microsoft/tui-test harness under
// scripts/tui-loop/ for that.

process.exit(0)
