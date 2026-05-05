#!/usr/bin/env bun

import { render } from 'ink'
import { loadSettings } from '../src/config'
import { runSession, type SessionHandle } from '../src/state/bootstrap'
import { startForceAvailabilityDriver } from '../src/state/forceAvailability'
import { createAppStore, messagesFromCaches, resetAccountScopedState } from '../src/state/store'
import {
  flushMessageCache,
  getMessageCachePath,
  loadMessageCache,
  scheduleMessageCacheSave,
} from '../src/state/messageCachePersistence'
import { App } from '../src/ui/App'
import { ErrorBoundary } from '../src/ui/ErrorBoundary'
import { startFocusTracker } from '../src/ui/focusTracker'
import { PollerProvider, type PollerHandleRef } from '../src/ui/PollerContext'
import { SessionProvider, type SessionApi } from '../src/ui/SessionContext'
import { StoreProvider } from '../src/ui/StoreContext'
import { debug, warn } from '../src/log'

const VERSION = '0.9.0'

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

const { profile: cliProfile, showHelp, showVersion, debugFlag } = parseArgs(Bun.argv.slice(2))

if (showHelp) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (showVersion) {
  process.stdout.write(`teaminal ${VERSION}\n`)
  process.exit(0)
}
if (debugFlag) process.env.TEAMINAL_DEBUG = '1'

if (!process.stdin.isTTY) {
  process.stderr.write(
    'teaminal: stdin is not a TTY. Run from an interactive terminal (iTerm, Terminal.app, etc).\n',
  )
  process.exit(2)
}

const store = createAppStore()

// Resolve the active profile. CLI overrides config; null falls through
// to owa-piggy's default profile.
const configResult = loadSettings()
store.set({ settings: configResult.settings })
let activeProfile: string | null = cliProfile ?? configResult.settings.activeAccount ?? null
if (configResult.source === 'file') {
  debug(`config: loaded from ${configResult.path}`)
}
for (const w of configResult.warnings) warn(w)

// Hydrate the per-profile message cache before mounting so the message
// pane shows history immediately. Failure is silent — the active poller
// repopulates from Graph.
function hydrateCache(profile: string | null): void {
  try {
    const persisted = loadMessageCache(getMessageCachePath(process.env, profile))
    if (Object.keys(persisted).length > 0) {
      store.set({
        messageCacheByConvo: persisted,
        messagesByConvo: messagesFromCaches(persisted),
      })
      debug(`bootstrap: hydrated ${Object.keys(persisted).length} cached conversations`)
    }
  } catch (err) {
    warn(
      'bootstrap: hydrate message cache failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
}
hydrateCache(activeProfile)

// Persist message cache on every relevant store change. Debounced inside
// scheduleMessageCacheSave so chat-spam doesn't thrash the disk. The
// path is tied to the *current* active profile and rebuilt on switch.
let lastSavedCaches = store.get().messageCacheByConvo
let activeCachePath = getMessageCachePath(process.env, activeProfile)
const cacheSubscription = store.subscribe((s) => {
  if (s.messageCacheByConvo === lastSavedCaches) return
  lastSavedCaches = s.messageCacheByConvo
  scheduleMessageCacheSave(s.messageCacheByConvo, undefined, activeCachePath)
})

// PollerHandleRef and current session handle are mutated by the
// bootstrap + restart flows; the App reads ref.current inside event
// handlers, so it observes the assignment without needing a re-render.
const pollerHandleRef: PollerHandleRef = { current: null }
let currentSession: SessionHandle | null = null

const ink = render(
  <ErrorBoundary>
    <StoreProvider store={store}>
      <PollerProvider handleRef={pollerHandleRef}>
        <SessionProvider api={makeSessionApi()}>
          <App />
        </SessionProvider>
      </PollerProvider>
    </StoreProvider>
  </ErrorBoundary>,
)

const focusTracker = startFocusTracker(store)
const forceAvailability = startForceAvailabilityDriver(store)

function makeSessionApi(): SessionApi {
  return {
    getActiveProfile: () => activeProfile,
    switchAccount,
  }
}

async function switchAccount(nextProfile: string | null): Promise<void> {
  if (currentSession?.profile === nextProfile) return
  // Tear down the running session first so its loops can't write into
  // the about-to-be-reset store.
  if (currentSession) {
    try {
      await currentSession.stop()
    } catch (err) {
      warn(
        'switch: stop previous session failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
    currentSession = null
  }
  // Flush the previous profile's cache before swapping the path.
  try {
    flushMessageCache()
  } catch {}
  resetAccountScopedState(store)
  activeProfile = nextProfile
  activeCachePath = getMessageCachePath(process.env, activeProfile)
  hydrateCache(activeProfile)

  try {
    currentSession = await runSession({
      store,
      profile: activeProfile,
      pollerHandleRef,
      onFatal: (kind, msg) => {
        warn(`bootstrap: fatal (${kind}): ${msg}`)
      },
    })
  } catch (err) {
    warn('switch: bootstrap failed:', err instanceof Error ? err.message : String(err))
    throw err
  }
}

;(async () => {
  try {
    currentSession = await runSession({
      store,
      profile: activeProfile,
      pollerHandleRef,
      onFatal: (kind, msg) => {
        ink.unmount()
        process.stderr.write(`teaminal: auth failed (${kind}): ${msg}\n`)
        process.exit(3)
      },
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
    // Best-effort shutdown. Stop the session (push + poll), then the
    // hardware-level helpers (focus tracker / force-availability), then
    // flush the cache one last time.
    try {
      cacheSubscription()
    } catch {}
    try {
      if (currentSession) await currentSession.stop()
    } catch {}
    try {
      forceAvailability.stop()
    } catch {}
    try {
      focusTracker.stop()
    } catch {}
    try {
      flushMessageCache()
    } catch {}
  }
})()
