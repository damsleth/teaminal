#!/usr/bin/env bun

import { render } from 'ink'
import { isRefreshExpiredError } from '../src/auth/owaPiggy'
import { loadSettings } from '../src/config'
import { loadThemeFile } from '../src/config/themes'
import { createAccountManager } from '../src/state/accountManager'
import { startForceAvailabilityDriver } from '../src/state/forceAvailability'
import { startSystemAppearanceDriver } from '../src/state/systemAppearance'
import { createAppStore } from '../src/state/store'
import { isSeededMode } from '../src/state/seedFixtures'
import { App } from '../src/ui/App'
import { ErrorBoundary } from '../src/ui/ErrorBoundary'
import { startFocusTracker } from '../src/ui/focusTracker'
import { probeCellAspect } from '../src/ui/kittyGraphics'
import {
  kittyKeyboardEnabled,
  probeKittyKeyboard,
  setKittyKeyboardEnabled,
} from '../src/ui/kittyKeyboard'
import { installTextSizing, probeTextSizing } from '../src/ui/textSizing'
import { cleanupImageTempFiles } from '../src/ui/openImageFile'
import { renderCleanExit } from '../src/ui/shutdown'
import { PollerProvider } from '../src/ui/PollerContext'
import { accountRef } from '../src/account'
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
  TEAMINAL_SEED        set to "fixtures" to run in seeded/offline mode (no auth)
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

// In seeded/offline mode (TEAMINAL_SEED=fixtures) the app is driven by a PTY
// harness (e.g. @microsoft/tui-test) which may not report isTTY=true on stdin.
// Skip the TTY guard so the real Ink render path works deterministically.
if (!process.stdin.isTTY && !isSeededMode()) {
  process.stderr.write(
    'teaminal: stdin is not a TTY. Run from an interactive terminal (iTerm, Terminal.app, etc).\n',
  )
  process.exit(2)
}

// Ask the terminal for its cell size before Ink takes raw mode - afterwards
// Ink owns stdin and the reply would land in the key handler. Sizes inline
// images against the real cell aspect instead of a 0.5 guess; a terminal
// that ignores the query keeps the fallback.
if (!isSeededMode()) await probeCellAspect()
// Same pre-Ink window: detect kitty text sizing (OSC 66). When present, the
// theme's per-element font sizes are rewritten into OSC 66 on the way out.
if (!isSeededMode() && (await probeTextSizing())) installTextSizing(process.stdout)
// Same pre-Ink window: ask the terminal whether it speaks the kitty keyboard
// protocol. Runs in seeded mode too (it draws nothing), so the tui flows
// exercise the probe-then-Ink handoff in a terminal that answers.
setKittyKeyboardEnabled(await probeKittyKeyboard())

const store = createAppStore()

// Resolve the active profile. CLI overrides config; null falls through
// to owa-piggy's default profile.
const configResult = loadSettings()
// In seeded mode, pin a deterministic settings baseline so snapshots don't
// depend on the running machine's config.json: a fixed theme (stable colors)
// and the diagnostics tails off (their live timestamps + absolute paths are
// non-deterministic and machine-specific).
const settings = isSeededMode()
  ? {
      ...configResult.settings,
      theme: 'dark',
      tailEvents: false,
      tailNetwork: false,
      tailDiagnostics: false,
    }
  : configResult.settings
store.set({ settings })
// Load custom theme JSON if settings.theme isn't a built-in name.
const themeResult = loadThemeFile(settings.theme)
if (themeResult.source === 'file') {
  store.set({ customTheme: { name: themeResult.name, data: themeResult.data ?? {} } })
  debug(`theme: loaded "${themeResult.name}" from ${themeResult.path}`)
}
for (const w of themeResult.warnings) warn(w)
const initialProfile: string | null = cliProfile ?? configResult.settings.activeAccount ?? null
const resolvedLogFile = cliLogFile ?? configResult.settings.logFile ?? null
if (resolvedLogFile) setLogFile(resolvedLogFile)
if (cliNetworkLog) setNetworkLog(cliNetworkLog)
if (configResult.source === 'file') {
  debug(`config: loaded from ${configResult.path}`)
}
for (const w of configResult.warnings) warn(w)

// Binds the store to the initial account and hydrates its caches before
// mounting, so the sidebar and message pane show history immediately.
const accounts = createAccountManager(store, initialProfile)

// Detect the OS appearance before the first render so the 'auto' theme
// paints the right base immediately, then keep it updated on an interval.
const systemAppearance = startSystemAppearanceDriver(store)

// `bun --watch` (dev:watch) sends SIGTERM before it re-execs on a file change.
// Ink's restore-cursor hooks signal-exit, which re-raises a SIGTERM nobody else
// listens for, so the process died instead of reloading. A listener of our own
// stops that; only under --watch, so a real `kill` still quits a normal run.
if (process.execArgv.includes('--watch')) process.on('SIGTERM', () => {})

const ink = render(
  <ErrorBoundary>
    <StoreProvider store={store}>
      <PollerProvider handleRef={accounts.pollerHandleRef}>
        <SessionProvider api={makeSessionApi()}>
          <App />
        </SessionProvider>
      </PollerProvider>
    </StoreProvider>
  </ErrorBoundary>,
  // Ink defaults to maxFps 30; fast OS key-repeat (50-90Hz on tuned
  // macOS setups) then coalesces 2-3 cursor steps into one paint and
  // list scrolling visibly jumps. 60fps keeps one paint per step.
  // The kitty keyboard protocol tells Ctrl+Enter (send) apart from Enter
  // (newline) in the composer. On when our own pre-Ink probe found it, not
  // Ink's 'auto', which probes stdin with a 'data' listener + unshift
  // (pitfall #10 territory).
  { maxFps: 60, kittyKeyboard: { mode: kittyKeyboardEnabled() ? 'enabled' : 'disabled' } },
)

// Safety net: a stray rejected promise from a fire-and-forget action (e.g. a
// failed reaction/delete) would otherwise terminate the process while Ink
// still holds the terminal in raw mode, leaving keystrokes leaking to the
// shell. Log and stay alive instead — explicit fatal paths use process.exit.
process.on('unhandledRejection', (reason) => {
  warn('unhandled rejection:', reason instanceof Error ? reason.message : String(reason))
})

const focusTracker = startFocusTracker(store)
// Seeded/offline mode must not touch the network: the forceAvailability driver
// PUTs to presence.teams.microsoft.com, so stub it out when seeded.
const forceAvailability = isSeededMode()
  ? { stop() {} }
  : startForceAvailabilityDriver(store, () => accountRef(accounts.activeProfile()))

function makeSessionApi(): SessionApi {
  return {
    getActiveProfile: () => accounts.activeProfile(),
    client: () => accounts.client(),
    switchAccount: (profile) => accounts.switchAccount(profile),
  }
}

function showAuthExpiredModal(profile: string | null, message: string): void {
  store.set({
    modal: { kind: 'auth-expired', profile, message, status: 'idle' },
    inputZone: 'menu',
  })
}

// Clean exit = the user quit and Ink unmounted on its own. The fatal paths
// below call process.exit(), which skips `finally` entirely, so this stays
// false and their error text is left on screen.
let cleanExit = false
;(async () => {
  try {
    try {
      await accounts.start((kind, msg) => {
        ink.unmount()
        process.stderr.write(`teaminal: auth failed (${kind}): ${msg}\n`)
        process.exit(3)
      })
    } catch (err) {
      // Refresh-token expiry: keep the UI mounted and offer
      // reseed / switch / quit instead of dumping the AAD message.
      // Any other bootstrap error still bubbles up to the outer
      // catch and exits.
      const message = err instanceof Error ? err.message : String(err)
      const profile = accounts.activeProfile()
      if (isRefreshExpiredError(message)) {
        warn(`bootstrap: refresh token expired for profile=${profile ?? '(default)'}`)
        showAuthExpiredModal(profile, message)
      } else {
        throw err
      }
    }

    await ink.waitUntilExit()
    cleanExit = true
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
      await accounts.stopAll()
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
    // Images handed to the platform viewer live in a private temp dir; don't
    // leave them on disk.
    try {
      cleanupImageTempFiles()
    } catch {}
    // Last: wipe Ink's final frame so the shell prompt comes back to a clean
    // screen. After the helpers, whose teardown writes control sequences of
    // its own.
    if (cleanExit) {
      try {
        renderCleanExit()
      } catch {}
    }
  }
})()
