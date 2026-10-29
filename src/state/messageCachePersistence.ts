// Persistent on-disk cache for chat / channel messages.
//
// Path: ${XDG_CACHE_HOME ?? ~/.cache}/teaminal/messages.json
//
// Goals:
//   - Avoid re-fetching pages of older messages on every startup (Graph
//     calls are expensive and rate-limited).
//   - Hydrate the message pane instantly so users see history before the
//     first active poll completes.
//
// Constraints:
//   - We never persist optimistic / failed sends (`_sending`, `_sendError`)
//     so a send-in-flight at exit doesn't reappear as a ghost on restart.
//   - We cap per-conversation storage and total-conversation count to keep
//     the file bounded.
//   - We persist `nextLink` and `fullyLoaded` so "Load older messages"
//     continues from where the last session left off.
//
// Save scheduling is debounced; the bootstrap also calls `flushMessageCache`
// on shutdown to write the latest snapshot synchronously.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { debouncedWriter, profileCachePath } from './cacheFiles'
import type { ChatMessage } from '../types'
import type { ConvKey, MessageCache } from './store'

const CACHE_VERSION = 1
const MAX_MESSAGES_PER_CONV = 200
const MAX_CONVS = 100

type Env = Record<string, string | undefined>

type PersistedCache = {
  messages: ChatMessage[]
  nextLink?: string
  fullyLoaded: boolean
  savedAt: string
}

type PersistedFile = {
  version: number
  caches: Record<string, PersistedCache>
}

export function getMessageCachePath(env: Env = process.env, profile?: string | null): string {
  // Per-profile file so switching accounts doesn't cross-pollute; the
  // default profile keeps the bare `messages.json` name.
  return profileCachePath('messages', env, profile)
}

export function loadMessageCache(
  path: string = getMessageCachePath(),
): Record<ConvKey, MessageCache> {
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
  if (file.version !== CACHE_VERSION || typeof file.caches !== 'object' || file.caches === null) {
    return {}
  }
  const out: Record<ConvKey, MessageCache> = {}
  for (const [conv, entry] of Object.entries(file.caches)) {
    if (!entry || !Array.isArray(entry.messages)) continue
    const messages = entry.messages.filter(
      (m): m is ChatMessage =>
        !!m && typeof m === 'object' && typeof (m as ChatMessage).id === 'string',
    )
    if (messages.length === 0) continue
    out[conv] = {
      messages,
      nextLink: typeof entry.nextLink === 'string' ? entry.nextLink : undefined,
      loadingOlder: false,
      fullyLoaded: entry.fullyLoaded === true,
    }
  }
  return out
}

export function serializeMessageCache(caches: Record<ConvKey, MessageCache>): PersistedFile {
  const entries = Object.entries(caches)
    .map(([conv, cache]): [string, PersistedCache] | null => {
      const cleaned = cache.messages.filter((m) => !m._sending && !m._sendError)
      if (cleaned.length === 0) return null
      const trimmed = cleaned.slice(-MAX_MESSAGES_PER_CONV)
      // Dropping older messages invalidates the paging state: the saved
      // next link points past messages that are no longer kept, and "fully
      // loaded" is no longer true. The next fetch brings a fresh link.
      const cut = trimmed.length < cleaned.length
      return [
        conv,
        {
          messages: trimmed,
          nextLink: cut ? undefined : cache.nextLink,
          fullyLoaded: cut ? false : cache.fullyLoaded,
          savedAt: new Date().toISOString(),
        },
      ]
    })
    .filter((entry): entry is [string, PersistedCache] => entry !== null)
    .slice(-MAX_CONVS)

  return {
    version: CACHE_VERSION,
    caches: Object.fromEntries(entries),
  }
}

export function saveMessageCacheNow(
  caches: Record<ConvKey, MessageCache>,
  path: string = getMessageCachePath(),
): void {
  const payload = serializeMessageCache(caches)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.messages.json.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    // Best-effort cleanup of the tmp file on failure. Swallow nested
    // errors: the caller already gets the original write failure below.
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    throw err
  }
}

const writer = debouncedWriter<Record<ConvKey, MessageCache>>((snapshot, target) =>
  saveMessageCacheNow(snapshot, target),
)

export function scheduleMessageCacheSave(
  snapshot: Record<ConvKey, MessageCache>,
  delayMs = 2000,
  path: string = getMessageCachePath(),
): void {
  writer.schedule(snapshot, path, delayMs)
}

// Write every pending snapshot now (all accounts' files).
export function flushMessageCache(): void {
  writer.flush()
}
