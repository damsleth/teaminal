// Hand a cached image blob to the platform's image viewer.
//
// Kept deliberately separate from openExternal(), which refuses anything that
// is not http(s)/mailto so a hostile message body can't smuggle a path or a
// shell argument. Here the path is one WE generate: a per-process temp
// directory plus a filename derived from the SHA-256 of the cache key, so no
// message-supplied text ever reaches the filesystem or the spawn arguments.
//
// Files are written 0600 and the whole directory is removed on exit
// (cleanupImageTempFiles, wired into the shutdown path) so nothing is left
// behind.

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { warn } from '../log'
import { detectImageFormat } from './kittyGraphics'

type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => { unref: () => void }

let dir: string | null = null

function sessionDir(): string {
  if (!dir) {
    dir = join(tmpdir(), `teaminal-images-${process.pid}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return dir
}

/**
 * Write an image blob to a private temp file and return its path, or null when
 * it can't be written. The filename comes from a hash of `cacheKey` — never
 * from the sender-supplied attachment name.
 */
export function materializeImage(cacheKey: string, data: Buffer): string | null {
  try {
    const stem = createHash('sha256').update(cacheKey).digest('hex').slice(0, 32)
    const ext = detectImageFormat(data) ?? 'png'
    const path = join(sessionDir(), `${stem}.${ext}`)
    writeFileSync(path, data, { mode: 0o600 })
    return path
  } catch (err) {
    warn(`image: could not write temp file: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function openerFor(platform: NodeJS.Platform, path: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [path] }
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', path] }
  return { cmd: 'xdg-open', args: [path] }
}

/** Open a path produced by materializeImage() in the platform image viewer. */
export function openImageFile(
  path: string,
  opts?: { platform?: NodeJS.Platform; spawn?: Spawner },
): boolean {
  // Refuse anything that isn't inside our own session directory: this function
  // must never become a general "open any path" primitive.
  if (!dir || !path.startsWith(`${dir}/`)) {
    warn('image: refusing to open a path outside the session image directory')
    return false
  }
  const platform = opts?.platform ?? process.platform
  const spawn =
    opts?.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, o) as unknown as { unref: () => void })
  const { cmd, args } = openerFor(platform, path)
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch (err) {
    warn(`image: failed to open viewer: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** Remove every materialized image. Safe to call more than once. */
export function cleanupImageTempFiles(): void {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
  dir = null
}
