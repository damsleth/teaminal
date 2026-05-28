// Ghostty layout driver. Uses AppleScript (via osascript) to open a new
// Ghostty window, run the host (conversation) pane, then split off the
// status / list / composer view panes. Each pane invokes the same
// teaminal binary with --pane=<zone>; views connect to the host's unix
// socket once it appears.
//
// Requires Ghostty 1.x with AppleScript support shipped (PR #11208,
// https://github.com/ghostty-org/ghostty/discussions/10201). On older
// builds the script falls back to driving the splits via `input text`,
// which types the command into a freshly-opened shell.
//
// Layout target:
//
//   ┌─────────────────────────────────────────────┐
//   │  status                                     │
//   ├─────────────┬───────────────────────────────┤
//   │             │                               │
//   │   list      │     conversation (HOST)       │
//   │             │                               │
//   ├─────────────┴───────────────────────────────┤
//   │  composer                                   │
//   └─────────────────────────────────────────────┘

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { socketPath } from '../ipc/socketPath'

export type GhostyLayoutOptions = {
  // Absolute path to the teaminal binary. Resolved from Bun.argv[0]
  // when not specified.
  binary?: string
  // owa-piggy profile alias. Passed to every pane so they connect to
  // the same socket.
  profile: string | null
  // ms to wait between operations (window creation, command typing,
  // split). Defaults sized for a fast Mac; bump it on cold-start
  // machines where ghostty takes a beat to settle.
  stepDelayMs?: number
  // ms to wait for the host socket to appear after the conversation
  // pane is launched. The other splits won't connect until this is up.
  socketTimeoutMs?: number
}

const DEFAULT_STEP_DELAY_MS = 350
const DEFAULT_SOCKET_TIMEOUT_MS = 5_000

export async function launchGhostlyLayout(opts: GhostyLayoutOptions): Promise<void> {
  const binary = opts.binary ?? resolveTeaminalBinary()
  const profileArg = opts.profile ? ` --profile ${shellQuote(opts.profile)}` : ''
  const cmd = (zone: string): string => `${shellQuote(binary)} --pane=${zone}${profileArg}`

  const stepDelay = (opts.stepDelayMs ?? DEFAULT_STEP_DELAY_MS) / 1000
  const socketTimeout = (opts.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS) / 1000

  const script = buildScript({
    convCmd: cmd('conversation'),
    statusCmd: cmd('status'),
    listCmd: cmd('list'),
    composerCmd: cmd('composer'),
    socketFile: socketPath(opts.profile),
    stepDelay,
    socketTimeout,
  })

  await runOsascript(script)
}

type ScriptVars = {
  convCmd: string
  statusCmd: string
  listCmd: string
  composerCmd: string
  socketFile: string
  stepDelay: number
  socketTimeout: number
}

function buildScript(v: ScriptVars): string {
  // `make new window` in Ghostty currently returns a tab-group
  // reference that AppleScript can't coerce to a window (error -2710).
  // Sidestep by spawning the window via `open -na Ghostty`; once it's
  // up we grab `focused terminal of selected tab of front window`,
  // which works reliably.
  //
  // For refocusing the conversation pane between splits we use the
  // `focus` verb directly on the captured `convTerm` reference — it's
  // documented as "focuses terminal and brings window to front" and
  // is robust as long as the underlying terminal still exists.
  const windowOpenWait = Math.max(0.7, v.stepDelay * 2)
  return [
    `do shell script "open -na Ghostty"`,
    `delay ${windowOpenWait}`,
    'tell application "Ghostty"',
    '  activate',
    '  set convTerm to focused terminal of selected tab of front window',
    `  tell convTerm to input text "${escape(v.convCmd)}" & return`,
    // Wait for the host's unix socket to appear before splitting off
    // view panes — they'd error out immediately otherwise.
    `  set socketDeadline to (current date) + ${v.socketTimeout}`,
    '  repeat until (current date) > socketDeadline',
    `    if (do shell script "test -S ${escape(v.socketFile)} && echo yes || echo no") is "yes" then exit repeat`,
    '    delay 0.1',
    '  end repeat',
    // Status pane — split up from conv.
    '  tell convTerm to split up',
    `  delay ${v.stepDelay}`,
    '  tell focused terminal of selected tab of front window to input text ' +
      `"${escape(v.statusCmd)}" & return`,
    '  focus convTerm',
    `  delay ${v.stepDelay}`,
    // Composer pane — split down from conv.
    '  tell convTerm to split down',
    `  delay ${v.stepDelay}`,
    '  tell focused terminal of selected tab of front window to input text ' +
      `"${escape(v.composerCmd)}" & return`,
    '  focus convTerm',
    `  delay ${v.stepDelay}`,
    // List pane — split left from conv.
    '  tell convTerm to split left',
    `  delay ${v.stepDelay}`,
    '  tell focused terminal of selected tab of front window to input text ' +
      `"${escape(v.listCmd)}" & return`,
    '  focus convTerm',
    'end tell',
  ].join('\n')
}

function escape(s: string): string {
  // Double-quoted AppleScript strings escape \ and " with a backslash.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function resolveTeaminalBinary(): string {
  // Bun.argv[1] is the script path under `bun run bin/teaminal.tsx`,
  // but is the resolved binary under a compiled `teaminal` executable.
  // Either works as a re-invocation target.
  const candidate = process.argv[1]
  if (candidate && existsSync(candidate)) return candidate
  // Fallback: assume `teaminal` is on PATH.
  return 'teaminal'
}

function runOsascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`osascript exited ${code}: ${stderr.trim()}`))
    })
    child.on('error', (err) => reject(err))
    child.stdin.write(script)
    child.stdin.end()
  })
}
