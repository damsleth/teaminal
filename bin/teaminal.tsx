#!/usr/bin/env bun

import { render } from 'ink'
import { isRefreshExpiredError } from '../src/auth/owaPiggy'
import { loadSettings } from '../src/config'
import { loadThemeFile } from '../src/config/themes'
import { runSession, type SessionHandle } from '../src/state/bootstrap'
import { startForceAvailabilityDriver } from '../src/state/forceAvailability'
import { startSystemAppearanceDriver } from '../src/state/systemAppearance'
import { createAppStore, messagesFromCaches, resetAccountScopedState } from '../src/state/store'
import {
  flushMessageCache,
  getMessageCachePath,
  loadMessageCache,
  scheduleMessageCacheSave,
} from '../src/state/messageCachePersistence'
import {
  flushListCache,
  getListCachePath,
  loadListCache,
  scheduleListCacheSave,
} from '../src/state/listCachePersistence'
import { App } from '../src/ui/App'
import { ErrorBoundary } from '../src/ui/ErrorBoundary'
import { startFocusTracker } from '../src/ui/focusTracker'
import { PollerProvider } from '../src/ui/PollerContext'
import type { PollerHandleRef } from '../src/state/poller'
import { SessionProvider, type SessionApi } from '../src/ui/SessionContext'
import { StoreProvider } from '../src/ui/StoreContext'
import { debug, setLogFile, setNetworkLog, warn } from '../src/log'
import { VERSION } from '../src/version'

const HELP = `teaminal ${VERSION}

  Lightweight terminal Microsoft Teams client.

USAGE
  teaminal [options]

OPTIONS
  --profile, -p <alias> owa-piggy profile alias (otherwise uses owa-piggy default)
  --debug              enable verbose stderr logging (sets TEAMINAL_DEBUG=1)
  --log-file <path>    mirror event log to <path> (redacted, append-only)
  --network-log <path> mirror Graph requests to <path> (redacted, append-only)
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
  logFile?: string
  networkLog?: string
} {
  const out: {
    profile?: string
    showHelp: boolean
    showVersion: boolean
    debugFlag: boolean
    logFile?: string
    networkLog?: string
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

// Hydrate the per-profile chat/teams list cache so the sidebar is
// populated before the first list-poll completes. The poller overwrites
// it on its first successful refresh; failure is silent.
function hydrateListCache(profile: string | null): void {
  try {
    const persisted = loadListCache(getListCachePath(process.env, profile))
    if (persisted) {
      store.set({
        chats: persisted.chats,
        teams: persisted.teams,
        channelsByTeam: persisted.channelsByTeam,
      })
      debug(
        `bootstrap: hydrated ${persisted.chats.length} chats / ${persisted.teams.length} teams from list cache`,
      )
    }
  } catch (err) {
    warn('bootstrap: hydrate list cache failed:', err instanceof Error ? err.message : String(err))
  }
}
hydrateCache(activeProfile)
hydrateListCache(activeProfile)

// Detect the OS appearance before the first render so the 'auto' theme
// paints the right base immediately, then keep it updated on an interval.
const systemAppearance = startSystemAppearanceDriver(store)

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

// Persist the chat/teams list whenever the poller refreshes it. Debounced
// inside scheduleListCacheSave; path tracks the active profile.
let lastSavedChats = store.get().chats
let lastSavedTeams = store.get().teams
let activeListCachePath = getListCachePath(process.env, activeProfile)
const listCacheSubscription = store.subscribe((s) => {
  if (s.chats === lastSavedChats && s.teams === lastSavedTeams) return
  lastSavedChats = s.chats
  lastSavedTeams = s.teams
  // Don't persist a wiped list — resetAccountScopedState clears chats/teams
  // on account switch, and that empty state must not clobber either
  // profile's cached sidebar.
  if (s.chats.length === 0 && s.teams.length === 0) return
  scheduleListCacheSave(
    { chats: s.chats, teams: s.teams, channelsByTeam: s.channelsByTeam },
    undefined,
    activeListCachePath,
  )
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
  // Flush the previous profile's caches before swapping the paths.
  try {
    flushMessageCache()
  } catch {}
  try {
    flushListCache()
  } catch {}
  resetAccountScopedState(store)
  activeProfile = nextProfile
  activeCachePath = getMessageCachePath(process.env, activeProfile)
  activeListCachePath = getListCachePath(process.env, activeProfile)
  hydrateCache(activeProfile)
  hydrateListCache(activeProfile)

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
      listCacheSubscription()
    } catch {}
    try {
      if (currentSession) await currentSession.stop()
    } catch {}
    try {
      forceAvailability.stop()
    } catch {}
    try {
      systemAppearance.stop()
    } catch {}
    try {
      focusTracker.stop()
    } catch {}
    try {
      flushMessageCache()
    } catch {}
    try {
      flushListCache()
    } catch {}
  }
})()
