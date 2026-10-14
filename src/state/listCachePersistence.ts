// Persistent on-disk cache for the chat / teams / channels list (sidebar).
//
// Path: ${XDG_CACHE_HOME ?? ~/.cache}/teaminal/list.json
//       (per-profile: list.<profile>.json)
//
// Goals:
//   - Hydrate the sidebar instantly on startup so the chat list is visible
//     before the first list-poll completes. The list endpoints
//     (listChats + teams/channels) are several round-trips and dominate
//     the visible startup latency once the message cache is warm.
//
// Constraints:
//   - We cap the number of chats / teams / channels-per-team to keep the
//     file bounded. Sidebar metadata is small, so the caps are generous.
//   - The cached list is a hint, not a source of truth: the active poller
//     overwrites it on its first successful refresh.
//
// Save scheduling is debounced; the bootstrap also calls `flushListCache`
// on shutdown to write the latest snapshot synchronously. Mirrors the
// shape of messageCachePersistence.ts so the two read the same way.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { debouncedWriter, profileCachePath } from './cacheFiles'
import type { Channel, Chat, Team } from '../types'

const CACHE_VERSION = 1
const MAX_CHATS = 300
const MAX_TEAMS = 100
const MAX_CHANNELS_PER_TEAM = 200

type Env = Record<string, string | undefined>

export type ListSnapshot = {
  chats: Chat[]
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
}

type PersistedFile = {
  version: number
  chats: Chat[]
  teams: Team[]
  channelsByTeam: Record<string, Channel[]>
  savedAt: string
}

export function getListCachePath(env: Env = process.env, profile?: string | null): string {
  // Per-profile file so switching accounts doesn't cross-pollute; the
  // default profile keeps the bare `list.json` name.
  return profileCachePath('list', env, profile)
}

export function loadListCache(path: string = getListCachePath()): ListSnapshot | null {
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const file = parsed as Partial<PersistedFile>
  if (file.version !== CACHE_VERSION) return null
  const chats = Array.isArray(file.chats)
    ? file.chats.filter((c): c is Chat => !!c && typeof (c as Chat).id === 'string')
    : []
  const teams = Array.isArray(file.teams)
    ? file.teams.filter((t): t is Team => !!t && typeof (t as Team).id === 'string')
    : []
  const channelsByTeam: Record<string, Channel[]> = {}
  if (file.channelsByTeam && typeof file.channelsByTeam === 'object') {
    for (const [teamId, channels] of Object.entries(file.channelsByTeam)) {
      if (!Array.isArray(channels)) continue
      channelsByTeam[teamId] = channels.filter(
        (c): c is Channel => !!c && typeof (c as Channel).id === 'string',
      )
    }
  }
  if (chats.length === 0 && teams.length === 0) return null
  return { chats, teams, channelsByTeam }
}

export function serializeListCache(snapshot: ListSnapshot): PersistedFile {
  const channelsByTeam: Record<string, Channel[]> = {}
  for (const [teamId, channels] of Object.entries(snapshot.channelsByTeam)) {
    channelsByTeam[teamId] = channels.slice(0, MAX_CHANNELS_PER_TEAM)
  }
  return {
    version: CACHE_VERSION,
    chats: snapshot.chats.slice(0, MAX_CHATS),
    teams: snapshot.teams.slice(0, MAX_TEAMS),
    channelsByTeam,
    savedAt: new Date().toISOString(),
  }
}

export function saveListCacheNow(snapshot: ListSnapshot, path: string = getListCachePath()): void {
  const payload = serializeListCache(snapshot)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.list.json.${process.pid}.${Date.now()}.tmp`)
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

const writer = debouncedWriter<ListSnapshot>((snapshot, target) =>
  saveListCacheNow(snapshot, target),
)

export function scheduleListCacheSave(
  snapshot: ListSnapshot,
  delayMs = 2000,
  path: string = getListCachePath(),
): void {
  writer.schedule(snapshot, path, delayMs)
}

// Write every pending snapshot now (all accounts' files).
export function flushListCache(): void {
  writer.flush()
}
