// Terminal bell + system notification helpers.
//
// bell() writes the BEL byte (0x07) to stdout. Most terminal emulators
// flash, beep, or both. Free, fast, and impossible to lose.
//
// system(title, body) attempts a desktop notification:
//   - kitty / Ghostty / WezTerm / iTerm2: writes the terminal's own
//             notification OSC (see terminalNotifySequence), falling
//             through to the per-platform path otherwise.
//   - darwin: spawns osascript with a synthesized AppleScript string
//             containing properly escaped title/body. We never invoke
//             a shell and the string is built with character-level
//             escaping rather than concatenation.
//   - linux:  spawns notify-send when available on PATH; silent no-op
//             when not.
//   - other:  silent no-op.
//
// Failures are swallowed - a missing notify-send or broken osascript
// must never crash the app.

const isDarwin = process.platform === 'darwin'
const isLinux = process.platform === 'linux'

export function bell(): void {
  process.stdout.write('\x07')
}

// Escape a JavaScript string for safe embedding in an AppleScript double-
// quoted literal. Apple uses backslash escapes; we handle backslash and
// double-quote, plus newlines (which AppleScript represents with \n).
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')
}

export type SpawnFn = (cmd: string, args: string[]) => Promise<{ exitCode: number }>

const defaultSpawn: SpawnFn = async (cmd, args) => {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: 'ignore', stderr: 'ignore' })
    const exitCode = await proc.exited
    return { exitCode }
  } catch {
    return { exitCode: -1 }
  }
}

let spawnFn: SpawnFn = defaultSpawn

export function __setSpawnForTests(fn: SpawnFn): void {
  spawnFn = fn
}

export function __resetForTests(): void {
  spawnFn = defaultSpawn
}

export type SystemNotifyResult = 'sent' | 'unsupported' | 'failed'

// Terminals that post a native notification themselves from an OSC
// escape: the banner is attributed to the terminal app (not Script
// Editor) and clicking it focuses the terminal window/tab. Null when
// the terminal isn't known to support it (Terminal.app, tmux, ...).
// Message text is untrusted: C0/C1 control bytes are stripped so a
// sender can't terminate the OSC and inject escapes of their own.
export function terminalNotifySequence(
  title: string,
  body: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  const t = clean(title)
  const b = clean(body)
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') {
    return `\x1b]99;i=teaminal:d=0;${t}\x1b\\\x1b]99;i=teaminal:p=body;${b}\x1b\\`
  }
  const term = env.TERM_PROGRAM
  if (term === 'ghostty' || term === 'WezTerm') {
    return `\x1b]777;notify;${t.replace(/;/g, ',')};${b}\x1b\\`
  }
  if (term === 'iTerm.app') return `\x1b]9;${t}: ${b}\x07`
  return null
}

export async function system(
  title: string,
  body: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SystemNotifyResult> {
  const seq = terminalNotifySequence(title, body, env)
  if (seq) {
    process.stdout.write(seq)
    return 'sent'
  }
  if (isDarwin) {
    const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`
    const { exitCode } = await spawnFn('osascript', ['-e', script])
    return exitCode === 0 ? 'sent' : 'failed'
  }
  if (isLinux) {
    const { exitCode } = await spawnFn('notify-send', [title, body])
    return exitCode === 0 ? 'sent' : 'unsupported'
  }
  return 'unsupported'
}

// Convenience: notify and bell together. Errors swallowed.
export function notifyMention(senderName: string, preview: string, scope: string): void {
  bell()
  void system(`teaminal · ${scope}`, `${senderName}: ${preview}`)
}

// Lower-level helpers used by the coalescing layer (src/notify/index.ts).
// notifyMention above remains for any caller that wants the raw
// fire-and-forget path with no coalescing.
export function ringBell(): void {
  bell()
}

export async function postBanner(title: string, body: string): Promise<SystemNotifyResult> {
  return system(title, body)
}
