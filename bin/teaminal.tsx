#!/usr/bin/env bun

import { render } from 'ink'
import { loadSettings } from '../src/config'
import { probeCapabilities } from '../src/graph/capabilities'
import { setActiveProfile } from '../src/graph/client'
import { getMe } from '../src/graph/me'
import { notifyMention } from '../src/notify/notify'
import { RealtimeEventBus } from '../src/realtime/events'
import { TrouterTransport } from '../src/realtime/trouter'
import { startPoller } from '../src/state/poller'
import { startForceAvailabilityDriver } from '../src/state/forceAvailability'
import { startRealtimeBridge } from '../src/state/realtimeBridge'
import { createAppStore, messagesFromCaches } from '../src/state/store'
import {
  flushMessageCache,
  loadMessageCache,
  scheduleMessageCacheSave,
} from '../src/state/messageCachePersistence'
import { getToken } from '../src/auth/owaPiggy'
import { App } from '../src/ui/App'
import { ErrorBoundary } from '../src/ui/ErrorBoundary'
import { startFocusTracker } from '../src/ui/focusTracker'
import { htmlToText } from '../src/ui/html'
import { PollerProvider, type PollerHandleRef } from '../src/ui/PollerContext'
import { StoreProvider } from '../src/ui/StoreContext'
import { debug, warn } from '../src/log'

const VERSION = '0.8.0'

const HELP = `teaminal ${VERSION}

  Lightweight terminal Microsoft Teams client.

USAGE
  teaminal [options]

OPTIONS
  --profile, -p <alias> owa-piggy profile alias (otherwise uses owa-piggy default)
  --debug              enable verbose stderr logging (sets TEAMINAL_DEBUG=1)
  --version            print version and exit
  --help               print this help and exit

ENVIRONMENT
  TEAMINAL_DEBUG       1/0, enables debug logging on stderr
  XDG_CONFIG_HOME      override config dir (default ~/.config)
`

function parseArgs(argv: string[]): {
  profile?: string
  showHelp: boolean
  showVersion: boolean
  debugFlag: boolean
} {
  const out: {
    profile?: string
    showHelp: boolean
    showVersion: boolean
    debugFlag: boolean
  } = { showHelp: false, showVersion: false, debugFlag: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.showHelp = true
    else if (a === '--version' || a === '-V') out.showVersion = true
    else if (a === '--debug') out.debugFlag = true
    else if (a === '--profile' || a === '-p') {
      const v = argv[i + 1]
      if (!v || v.startsWith('-')) {
        process.stderr.write('teaminal: --profile requires a value\n')
        process.exit(2)
      }
      out.profile = v
      i++
    } else {
      process.stderr.write(`teaminal: unknown argument: ${a}\n`)
      process.exit(2)
    }
  }
  return out
}

const { profile, showHelp, showVersion, debugFlag } = parseArgs(Bun.argv.slice(2))

if (showHelp) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (showVersion) {
  process.stdout.write(`teaminal ${VERSION}\n`)
  process.exit(0)
}
if (debugFlag) process.env.TEAMINAL_DEBUG = '1'

// Ink requires a TTY to set raw mode for keyboard input. Pipes, CI, and
// scripted invocations should get a clear message instead of a React stack
// trace from somewhere deep in the reconciler.
if (!process.stdin.isTTY) {
  process.stderr.write(
    'teaminal: stdin is not a TTY. Run from an interactive terminal (iTerm, Terminal.app, etc).\n',
  )
  process.exit(2)
}

const store = createAppStore()

// Hydrate persistent message cache before the UI mounts so the message
// pane shows history immediately and "Load older messages" knows whether
// more pages are reachable. Failures are silent — the active poller will
// repopulate from Graph.
try {
  const persisted = loadMessageCache()
  if (Object.keys(persisted).length > 0) {
    store.set({
      messageCacheByConvo: persisted,
      messagesByConvo: messagesFromCaches(persisted),
    })
    debug(`bootstrap: hydrated ${Object.keys(persisted).length} cached conversations`)
  }
} catch (err) {
  warn('bootstrap: hydrate message cache failed:', err instanceof Error ? err.message : String(err))
}

// Persist message cache on every relevant store change. Debounced inside
// scheduleMessageCacheSave so chat-spam doesn't thrash the disk.
let lastSavedCaches = store.get().messageCacheByConvo
store.subscribe((s) => {
  if (s.messageCacheByConvo === lastSavedCaches) return
  lastSavedCaches = s.messageCacheByConvo
  scheduleMessageCacheSave(s.messageCacheByConvo)
})

// Load user preferences from ~/.config/teaminal/config.json (or
// $XDG_CONFIG_HOME/teaminal/config.json). Missing file = defaults; any
// validation warnings go to stderr under TEAMINAL_DEBUG.
const configResult = loadSettings()
store.set({ settings: configResult.settings })
if (profile) setActiveProfile(profile)
else if (configResult.settings.activeAccount) setActiveProfile(configResult.settings.activeAccount)
if (configResult.source === 'file') {
  debug(`config: loaded from ${configResult.path}`)
}
for (const w of configResult.warnings) warn(w)

// PollerHandleRef is mutated by the bootstrap below once startPoller
// resolves; the App reads ref.current inside event handlers, so it
// observes the assignment without needing a re-render.
const pollerHandleRef: PollerHandleRef = { current: null }

// Start the UI immediately so the user sees a frame within hundreds of
// milliseconds; data fills in as auth + capability probe + poller complete.
const ink = render(
  <ErrorBoundary>
    <StoreProvider store={store}>
      <PollerProvider handleRef={pollerHandleRef}>
        <App />
      </PollerProvider>
    </StoreProvider>
  </ErrorBoundary>,
)

// Terminal focus reporting. Started before bootstrap so the first
// force-availability PUT (driven below) sees an accurate focused state.
// Safe to start before render/auth: the tracker only writes a single
// CSI sequence and attaches a stdin listener.
const focusTracker = startFocusTracker(store)

// Force-availability driver. Reads store.settings.forceAvailableWhenFocused
// and store.terminalFocused; PUTs presence.teams.microsoft.com when both
// are true. Token errors disable for the session, never crash.
const forceAvailability = startForceAvailabilityDriver(store)

// Background bootstrap. Errors update the store (conn) so the StatusBar
// reflects them; fatal auth issues print to stderr and exit.
;(async () => {
  let handle: Awaited<ReturnType<typeof startPoller>> | null = null
  let bridge: ReturnType<typeof startRealtimeBridge> | null = null
  let bus: RealtimeEventBus | null = null
  let transport: TrouterTransport | null = null
  try {
    debug('bootstrap: getMe()')
    const me = await getMe()
    store.set({ me })

    debug('bootstrap: probeCapabilities()')
    const capabilities = await probeCapabilities()
    store.set({ capabilities })

    if (capabilities.me.ok === false && capabilities.me.reason === 'unauthorized') {
      ink.unmount()
      process.stderr.write(`teaminal: auth failed: ${capabilities.me.message}\n`)
      process.exit(3)
    }

    debug('bootstrap: startPoller()')
    handle = startPoller({
      store,
      onError: (loop, err) => warn(`poller[${loop}]:`, err.message),
      onMention: (event) => {
        const sender = event.message.from?.user?.displayName ?? 'someone'
        const raw = event.message.body.content ?? ''
        const preview =
          event.message.body.contentType === 'text'
            ? raw.replace(/\s+/g, ' ').trim()
            : htmlToText(raw)
        const scope = event.conv.startsWith('chat:') ? 'chat' : 'channel'
        notifyMention(sender, preview.slice(0, 120), scope)
      },
    })
    pollerHandleRef.current = handle

    // Real-time push layer (Option E hybrid). The event bus and bridge
    // run immediately; the trouter transport connects in the background.
    // If trouter fails, the app degrades to polling-only — no user-facing
    // error beyond the header indicator changing from green to gray.
    debug('bootstrap: startRealtimeBridge()')
    bus = new RealtimeEventBus()
    bridge = startRealtimeBridge({
      bus,
      store,
      getPoller: () => pollerHandleRef.current,
    })

    debug('bootstrap: trouter transport')
    transport = new TrouterTransport({
      bus,
      getToken: () => getToken(profile),
      profile,
    })
    transport.onStateChange((state) => {
      debug('trouter: state ->', state)
      store.set({
        realtimeState:
          state === 'disconnected'
            ? 'off'
            : state === 'connecting'
              ? 'connecting'
              : state === 'connected'
                ? 'connected'
                : state === 'reconnecting'
                  ? 'reconnecting'
                  : 'error',
      })
    })
    // Connect in the background — never block the main bootstrap.
    transport.connect().catch((err) => {
      warn('trouter: initial connect failed:', err instanceof Error ? err.message : String(err))
    })

    await ink.waitUntilExit()
  } catch (err) {
    ink.unmount()
    if (err instanceof Error) {
      process.stderr.write(`teaminal: ${err.message}\n`)
    } else {
      process.stderr.write(`teaminal: unexpected error: ${String(err)}\n`)
    }
    process.exit(1)
  } finally {
    // Best-effort shutdown. Each step is independently guarded so a
    // failure in one teardown doesn't skip the rest. Order matters:
    // stop the push side before the poll side so a final realtime event
    // can't enqueue work onto a torn-down poller.
    try {
      transport?.disconnect()
    } catch {}
    try {
      bridge?.stop()
    } catch {}
    try {
      bus?.clear()
    } catch {}
    pollerHandleRef.current = null
    try {
      forceAvailability.stop()
    } catch {}
    try {
      focusTracker.stop()
    } catch {}
    try {
      if (handle) await handle.stop()
    } catch {}
    try {
      flushMessageCache()
    } catch {}
  }
})()
