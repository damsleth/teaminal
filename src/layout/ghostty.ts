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
  // AppleScript quoting: backslashes and double quotes are special inside
  // string literals. The commands are already shell-quoted, so they may
  // contain single quotes which AppleScript doesn't care about.
  //
  // We deliberately don't capture the result of `make new window` —
  // Ghostty returns a tab-group reference there, not a window, and
  // assigning it to `convWindow` was failing with -2710. Instead we
  // reference `front window` after each operation; Ghostty brings the
  // newly-active window/split to the front, so this is reliable.
  return [
    'tell application "Ghostty"',
    '  activate',
    '  make new window',
    `  delay ${v.stepDelay}`,
    // The freshly created window's focused terminal IS the conv pane.
    // Capture its id so we can refocus it between splits without
    // chasing whatever the "front" reference points at.
    '  set convTerm to focused terminal of selected tab of front window',
    '  set convId to id of convTerm',
    // Launch the host pane via the user's shell.
    `  tell convTerm to input text "${escape(v.convCmd)}" & return`,
    // Wait for the host's unix socket to appear before splitting off
    // the view panes; they'd error out immediately otherwise.
    `  set socketDeadline to (current date) + ${v.socketTimeout}`,
    '  repeat until (current date) > socketDeadline',
    `    if (do shell script "test -S ${escape(v.socketFile)} && echo yes || echo no") is "yes" then exit repeat`,
    '    delay 0.1',
    '  end repeat',
    // Status pane — split up from the conversation pane.
    '  tell convTerm to split up',
    `  delay ${v.stepDelay}`,
    '  tell focused terminal of selected tab of front window to input text ' +
      `"${escape(v.statusCmd)}" & return`,
    // Refocus conv via its captured id so the next split lands on it.
    '  my focusTerminalById(convId)',
    `  delay ${v.stepDelay}`,
    // Composer pane — split down from conv.
    '  tell convTerm to split down',
    `  delay ${v.stepDelay}`,
    '  tell focused terminal of selected tab of front window to input text ' +
      `"${escape(v.composerCmd)}" & return`,
    '  my focusTerminalById(convId)',
    `  delay ${v.stepDelay}`,
    // List pane — split left from conv.
    '  tell convTerm to split left',
    `  delay ${v.stepDelay}`,
    '  tell focused terminal of selected tab of front window to input text ' +
      `"${escape(v.listCmd)}" & return`,
    '  my focusTerminalById(convId)',
    'end tell',
    '',
    // Helper handler at the top level (must live outside the `tell`).
    'on focusTerminalById(targetId)',
    '  tell application "Ghostty"',
    '    repeat with w in windows',
    '      repeat with t in tabs of w',
    '        try',
    '          set ft to focused terminal of t',
    '          if (id of ft) is targetId then',
    '            focus ft',
    '            return',
    '          end if',
    '        end try',
    '      end repeat',
    '    end repeat',
    '  end tell',
    'end focusTerminalById',
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
