// Persistent on-disk cache for the userId -> display name index (see
// nameIndex.ts for why the index exists).
//
// Path: ${XDG_CACHE_HOME ?? ~/.cache}/teaminal/names.json
//       (per-profile: names.<profile>.json)
//
// Goals:
//   - Carry resolved sender names across restarts so the sidebar shows
//     real names for 1:1 / group chats immediately, instead of falling
//     back to "(unknown)" or the raw email until a chat is opened (and
//     its messages re-fetched) post-launch.
//
// Constraints:
//   - The index is just userId -> name strings, so it's tiny; we still
//     cap the entry count to keep the file bounded across years of use.
//
// Save scheduling is debounced; the bootstrap also calls `flushNameCache`
// on shutdown to write the latest snapshot synchronously. Mirrors the
// shape of listCachePersistence.ts so the two read the same way.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { debouncedWriter, profileCachePath } from './cacheFiles'

const CACHE_VERSION = 1
const MAX_NAMES = 5000

type Env = Record<string, string | undefined>

export type NameIndex = Record<string, string>

type PersistedFile = {
  version: number
  names: NameIndex
  savedAt: string
}

export function getNameCachePath(env: Env = process.env, profile?: string | null): string {
  // Per-profile file so switching accounts doesn't cross-pollute; the
  // default profile keeps the bare `names.json` name.
  return profileCachePath('names', env, profile)
}

export function loadNameCache(path: string = getNameCachePath()): NameIndex {
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const file = parsed as Partial<PersistedFile>
  if (file.version !== CACHE_VERSION) return {}
  if (!file.names || typeof file.names !== 'object') return {}
  const out: NameIndex = {}
  for (const [id, name] of Object.entries(file.names)) {
    if (typeof id === 'string' && id.length > 0 && typeof name === 'string' && name.length > 0) {
      out[id] = name
    }
  }
  return out
}

export function serializeNameCache(names: NameIndex): PersistedFile {
  const entries = Object.entries(names).slice(0, MAX_NAMES)
  return {
    version: CACHE_VERSION,
    names: Object.fromEntries(entries),
    savedAt: new Date().toISOString(),
  }
}

export function saveNameCacheNow(names: NameIndex, path: string = getNameCachePath()): void {
  const payload = serializeNameCache(names)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.names.json.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    throw err
  }
}

const writer = debouncedWriter<NameIndex>((snapshot, target) => saveNameCacheNow(snapshot, target))

export function scheduleNameCacheSave(
  snapshot: NameIndex,
  delayMs = 2000,
  path: string = getNameCachePath(),
): void {
  writer.schedule(snapshot, path, delayMs)
}

// Write every pending snapshot now (all accounts' files).
export function flushNameCache(): void {
  writer.flush()
}
