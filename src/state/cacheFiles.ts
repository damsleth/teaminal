// Shared plumbing for the per-account cache files (messages, list, names,
// images): where they live, and a debounced writer per file.

import { recordEvent } from '../log'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { accountRef, profileSlug } from '../account'

type Env = Record<string, string | undefined>

// ${XDG_CACHE_HOME ?? $HOME/.cache}/teaminal
export function teaminalCacheDir(env: Env = process.env): string {
  const xdg = env.XDG_CACHE_HOME
  const base =
    xdg && xdg.length > 0
      ? xdg
      : join(env.HOME && env.HOME.length > 0 ? env.HOME : homedir(), '.cache')
  return join(base, 'teaminal')
}

// `<kind>.json` for the default profile, `<kind>.<slug>.json` otherwise.
export function profileCachePath(
  kind: 'messages' | 'list' | 'names',
  env: Env,
  profile: string | null | undefined,
): string {
  const slug = profileSlug(accountRef(profile))
  return join(teaminalCacheDir(env), slug === null ? `${kind}.json` : `${kind}.${slug}.json`)
}

// Debounced, best-effort writes keyed by file path. Each path has its own
// timer and pending snapshot, so two accounts saving within the debounce
// window both land (a single shared slot let the last scheduler win).
export function debouncedWriter<T>(write: (snapshot: T, path: string) => void) {
  const pending = new Map<string, { snapshot: T; timer: ReturnType<typeof setTimeout> }>()
  // Paths whose write failure was already logged (once each, not per save).
  const failed = new Set<string>()
  const writeNow = (snapshot: T, path: string): void => {
    try {
      write(snapshot, path)
      failed.delete(path)
    } catch (err) {
      // Best-effort: the app keeps working without the cache file, but say so.
      if (!failed.has(path)) {
        failed.add(path)
        recordEvent(
          'app',
          'warn',
          `cache write failed for ${path}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }
  return {
    schedule(snapshot: T, path: string, delayMs: number): void {
      const entry = pending.get(path)
      if (entry) {
        entry.snapshot = snapshot
        return
      }
      const created = {
        snapshot,
        timer: setTimeout(() => {
          pending.delete(path)
          writeNow(created.snapshot, path)
        }, delayMs),
      }
      pending.set(path, created)
    },
    // Write every pending snapshot now (shutdown, switch, cache clear).
    flush(): void {
      for (const [path, entry] of pending) {
        clearTimeout(entry.timer)
        pending.delete(path)
        writeNow(entry.snapshot, path)
      }
    },
  }
}
