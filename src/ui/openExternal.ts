// Opens a URL in the user's default browser, cross-platform.
//
// macOS:  open <url>
// Linux:  xdg-open <url>
// Windows: rundll32 url.dll,FileProtocolHandler <url>
//
// Best-effort and non-blocking: the child is spawned detached and unref'd so
// it can't keep the TUI alive, and any spawn failure is logged, never thrown.
// Only http(s) / mailto URLs are passed through, so a malicious message body
// can't smuggle a shell argument or a file:// path.

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { warn } from '../log'

type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => { unref: () => void }

function isSafeUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

function openerFor(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] }
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { cmd: 'xdg-open', args: [url] }
}

// Returns true when the URL was handed to a platform opener, false when it
// was rejected (unsupported scheme) or the spawn threw. Exposed args make
// it unit-testable without actually launching a browser.
export function openExternal(
  url: string,
  opts?: { platform?: NodeJS.Platform; spawn?: Spawner },
): boolean {
  if (!isSafeUrl(url)) {
    warn(`openExternal: refusing to open non-http(s) URL`)
    return false
  }
  const platform = opts?.platform ?? process.platform
  const spawn =
    opts?.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, o) as unknown as { unref: () => void })
  const { cmd, args } = openerFor(platform, url)
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false })
    child.unref()
    return true
  } catch (err) {
    warn(`openExternal: failed to open URL: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
