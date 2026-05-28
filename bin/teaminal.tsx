#!/usr/bin/env bun

import { render } from 'ink'
import { isRefreshExpiredError } from '../src/auth/owaPiggy'
import { loadSettings } from '../src/config'
import { loadThemeFile } from '../src/config/themes'
import { startHost } from '../src/ipc/host'
import { connectView } from '../src/ipc/view'
import { launchGhostlyLayout } from '../src/layout/ghostty'
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
import { PollerProvider } from '../src/ui/PollerContext'
import type { PollerHandleRef } from '../src/state/poller'
import { SessionProvider, type SessionApi } from '../src/ui/SessionContext'
import { StoreProvider } from '../src/ui/StoreContext'
import {
  makeHostDispatch,
  makeViewDispatch,
  ViewDispatchProvider,
} from '../src/ui/ViewDispatchContext'
import { debug, setLogFile, setNetworkLog, warn } from '../src/log'
import { VERSION } from '../src/version'

const HELP = `teaminal ${VERSION}

  Lightweight terminal Microsoft Teams client.

USAGE
  teaminal [options]

OPTIONS
  --profile, -p <alias> owa-piggy profile alias (otherwise uses owa-piggy default)
  --pane <zone>        render only one zone of the UI (list|conversation|status|composer).
                       Intended for split-pane layouts; see --layout=ghostty.
  --layout <name>      open teaminal as a split-pane layout (currently only "ghostty").
                       Spawns a new Ghostty window with conversation + list + status + composer
                       panes via AppleScript. macOS / Ghostty only.
  --debug              enable verbose stderr logging (sets TEAMINAL_DEBUG=1)
  --log-file <path>    mirror event log to <path> (redacted, append-only)
  --network-log <path> mirror Graph requests to <path> (redacted, append-only)
  --version            print version and exit
  --help               print this help and exit

ENVIRONMENT
  TEAMINAL_DEBUG       1/0, enables debug logging on stderr
  XDG_CONFIG_HOME      override config dir (default ~/.config)
`

export type Pane = 'list' | 'conversation' | 'status' | 'composer'
const PANES: ReadonlyArray<Pane> = ['list', 'conversation', 'status', 'composer']
export type Layout = 'ghostty'
const LAYOUTS: ReadonlyArray<Layout> = ['ghostty']

function parseArgs(argv: string[]): {
  profile?: string
  pane?: Pane
  layout?: Layout
  showHelp: boolean
  showVersion: boolean
  debugFlag: boolean
  logFile?: string
  networkLog?: string
} {
  const out: {
    profile?: string
    pane?: Pane
    layout?: Layout
    showHelp: boolean
    showVersion: boolean
    debugFlag: boolean
    logFile?: string
    networkLog?: string
  } = { showHelp: false, showVersion: false, debugFlag: false }
  // Allow both `--flag value` and `--flag=value`. For the equals form we
  // splice the parts back into argv so the rest of the parser is
  // unchanged.
  const expanded: string[] = []
  for (const a of argv) {
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=')
      expanded.push(a.slice(0, eq), a.slice(eq + 1))
    } else {
      expanded.push(a)
    }
  }
  argv = expanded
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
    } else if (a === '--pane') {
      const v = argv[i + 1]
      if (!v || v.startsWith('-')) {
        process.stderr.write('teaminal: --pane requires a value\n')
        process.exit(2)
      }
      if (!PANES.includes(v as Pane)) {
        process.stderr.write(`teaminal: --pane must be one of ${PANES.join('|')}\n`)
        process.exit(2)
      }
      out.pane = v as Pane
      i++
    } else if (a === '--layout') {
      const v = argv[i + 1]
      if (!v || v.startsWith('-')) {
        process.stderr.write('teaminal: --layout requires a value\n')
        process.exit(2)
      }
      if (!LAYOUTS.includes(v as Layout)) {
        process.stderr.write(`teaminal: --layout must be one of ${LAYOUTS.join('|')}\n`)
        process.exit(2)
      }
      out.layout = v as Layout
      i++
    } else if (a === '--log-file') {
      const v = argv[i + 1]
      if (!v || v.startsWith('-')) {
        process.stderr.write('teaminal: --log-file requires a path\n')
        process.exit(2)
      }
      out.logFile = v
      i++
    } else if (a === '--network-log') {
      const v = argv[i + 1]
      if (!v || v.startsWith('-')) {
        process.stderr.write('teaminal: --network-log requires a path\n')
        process.exit(2)
      }
      out.networkLog = v
      i++
    } else {
      process.stderr.write(`teaminal: unknown argument: ${a}\n`)
      process.exit(2)
    }
  }
  return out
}

const {
  profile: cliProfile,
  pane: cliPane,
  layout: cliLayout,
  showHelp,
  showVersion,
  debugFlag,
  logFile: cliLogFile,
  networkLog: cliNetworkLog,
} = parseArgs(Bun.argv.slice(2))

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

// Layout driver: spawn a new Ghostty window split into the four panes
// and exit. The actual teaminal panes run as child processes inside
// Ghostty terminals.
if (cliLayout === 'ghostty') {
  try {
    await launchGhostlyLayout({ profile: cliProfile ?? null })
    process.exit(0)
  } catch (err) {
    process.stderr.write(
      `teaminal: --layout=ghostty failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(4)
  }
}

// View mode: thin client. Skip bootstrap, connect to the host's socket,
// render only the requested zone. The host (conversation pane, or the
// single-process shell) owns the poller, auth, chatsvc.
async function runViewMode(pane: 'list' | 'status' | 'composer'): Promise<void> {
  const profile: string | null = cliProfile ?? null
  const view = await connectView({ pane, profile })
  await view.ready

  // Apply theme settings from the synced store. Custom themes are
  // already mirrored as state, so no need to load from disk.
  const viewDispatch = makeViewDispatch(view)
  // PollerProvider expects a handleRef; in view mode no poller runs
  // here, so we pass a no-op ref. Components that try to read
  // pollerRef.current?.refresh() are routed through viewDispatch
  // instead and never touch this ref.
  const noopPollerRef: PollerHandleRef = { current: null }

  const viewInk = render(
    <ErrorBoundary>
      <StoreProvider store={view.store}>
        <PollerProvider handleRef={noopPollerRef}>
          <SessionProvider
            api={{ getActiveProfile: () => profile, switchAccount: async () => {} }}
          >
            <ViewDispatchProvider value={viewDispatch}>
              <App pane={pane} />
            </ViewDispatchProvider>
          </SessionProvider>
        </PollerProvider>
      </StoreProvider>
    </ErrorBoundary>,
  )

  // Exit the view as soon as either Ink unmounts (user quits) or the
  // host disconnects (conversation pane closed). Whichever wins gets
  // teardown.
  await Promise.race([viewInk.waitUntilExit(), view.closed])
  try {
    viewInk.unmount()
  } catch {}
  try {
    view.stop()
  } catch {}
}

const isViewMode = cliPane !== undefined && cliPane !== 'conversation'
if (isViewMode) {
  await runViewMode(cliPane as 'list' | 'status' | 'composer')
  process.exit(0)
}

const store = createAppStore()

// Resolve the active profile. CLI overrides config; null falls through
// to owa-piggy's default profile.
const configResult = loadSettings()
store.set({ settings: configResult.settings })
// Load custom theme JSON if settings.theme isn't a built-in name.
const themeResult = loadThemeFile(configResult.settings.theme)
if (themeResult.source === 'file') {
  store.set({ customTheme: { name: themeResult.name, data: themeResult.data ?? {} } })
  debug(`theme: loaded "${themeResult.name}" from ${themeResult.path}`)
}
for (const w of themeResult.warnings) warn(w)
let activeProfile: string | null = cliProfile ?? configResult.settings.activeAccount ?? null
const resolvedLogFile = cliLogFile ?? configResult.settings.logFile ?? null
if (resolvedLogFile) setLogFile(resolvedLogFile)
if (cliNetworkLog) setNetworkLog(cliNetworkLog)
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

const hostDispatch = makeHostDispatch(pollerHandleRef)
const ink = render(
  <ErrorBoundary>
    <StoreProvider store={store}>
      <PollerProvider handleRef={pollerHandleRef}>
        <SessionProvider api={makeSessionApi()}>
          <ViewDispatchProvider value={hostDispatch}>
            <App pane={cliPane} />
          </ViewDispatchProvider>
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

function showAuthExpiredModal(profile: string | null, message: string): void {
  store.set({
    modal: { kind: 'auth-expired', profile, message, status: 'idle' },
    inputZone: 'menu',
  })
}

// IPC host server. Started only when this process is the conversation
// pane (or the legacy single-process shell). View panes find this via
// the unix socket at $XDG_RUNTIME_DIR/teaminal-<profile>.sock.
let ipcHost: Awaited<ReturnType<typeof startHost>> | null = null

;(async () => {
  try {
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
    } catch (err) {
      // Refresh-token expiry: keep the UI mounted and offer
      // reseed / switch / quit instead of dumping the AAD message.
      // Any other bootstrap error still bubbles up to the outer
      // catch and exits.
      const message = err instanceof Error ? err.message : String(err)
      if (isRefreshExpiredError(message)) {
        warn(`bootstrap: refresh token expired for profile=${activeProfile ?? '(default)'}`)
        showAuthExpiredModal(activeProfile, message)
      } else {
        throw err
      }
    }

    // Expose the store on a unix socket so view panes (list / status /
    // composer) can attach. Failure here is non-fatal — the single
    // process shell still works without it.
    try {
      ipcHost = await startHost({ store, profile: activeProfile, pollerRef: pollerHandleRef })
      debug(`ipc/host: listening on ${ipcHost.socket}`)
    } catch (err) {
      warn('ipc/host: start failed:', err instanceof Error ? err.message : String(err))
    }

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
    // Best-effort shutdown. Stop the IPC host first so view panes
    // disconnect cleanly, then the session (push + poll), the
    // hardware-level helpers (focus tracker / force-availability), and
    // finally flush the cache.
    try {
      ipcHost?.stop()
    } catch {}
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
