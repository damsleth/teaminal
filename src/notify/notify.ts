// Terminal bell + system notification helpers.
//
// bell() writes the BEL byte (0x07) to stdout. Most terminal emulators
// flash, beep, or both. Free, fast, and impossible to lose.
//
// system(title, body) attempts a desktop notification:
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

export async function system(title: string, body: string): Promise<SystemNotifyResult> {
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
