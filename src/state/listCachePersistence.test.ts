import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, Chat, Team } from '../types'
import {
  flushListCache,
  getListCachePath,
  loadListCache,
  saveListCacheNow,
  scheduleListCacheSave,
  serializeListCache,
  type ListSnapshot,
} from './listCachePersistence'

const tmpDirs: string[] = []

function makeTmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teaminal-listcache-'))
  tmpDirs.push(dir)
  return join(dir, 'list.json')
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

function chat(id: string): Chat {
  return { id, chatType: 'oneOnOne', createdDateTime: '2026-01-01T00:00:00Z' }
}
function team(id: string): Team {
  return { id, displayName: `team-${id}` }
}
function channel(id: string): Channel {
  return { id, displayName: `chan-${id}` }
}

describe('getListCachePath profile scoping', () => {
  test('default profile uses the bare path', () => {
    expect(getListCachePath({ HOME: '/tmp/home', XDG_CACHE_HOME: '/tmp/cache' }, null)).toBe(
      '/tmp/cache/teaminal/list.json',
    )
  })
  test('named profile gets its own filename', () => {
    expect(getListCachePath({ HOME: '/tmp/home', XDG_CACHE_HOME: '/tmp/cache' }, 'work')).toBe(
      '/tmp/cache/teaminal/list.work.json',
    )
  })
  test('falls back to HOME/.cache', () => {
    expect(getListCachePath({ HOME: '/home/me' }, null)).toBe('/home/me/.cache/teaminal/list.json')
  })
})

describe('saveListCacheNow / loadListCache', () => {
  test('round-trips chats, teams, and channels', () => {
    const path = makeTmpFile()
    const snap: ListSnapshot = {
      chats: [chat('c1'), chat('c2')],
      teams: [team('t1')],
      channelsByTeam: { t1: [channel('ch1'), channel('ch2')] },
    }
    saveListCacheNow(snap, path)
    expect(existsSync(path)).toBe(true)
    const loaded = loadListCache(path)
    expect(loaded?.chats.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(loaded?.teams.map((t) => t.id)).toEqual(['t1'])
    expect(loaded?.channelsByTeam.t1?.map((c) => c.id)).toEqual(['ch1', 'ch2'])
  })

  test('returns null when the file is missing', () => {
    expect(loadListCache(makeTmpFile())).toBeNull()
  })

  test('returns null on corrupted JSON', () => {
    const path = makeTmpFile()
    writeFileSync(path, '{not json')
    expect(loadListCache(path)).toBeNull()
  })

  test('returns null on a wrong version', () => {
    const path = makeTmpFile()
    writeFileSync(path, JSON.stringify({ version: 999, chats: [chat('c1')], teams: [] }))
    expect(loadListCache(path)).toBeNull()
  })

  test('returns null when both chats and teams are empty', () => {
    const path = makeTmpFile()
    saveListCacheNow({ chats: [], teams: [], channelsByTeam: {} }, path)
    expect(loadListCache(path)).toBeNull()
  })

  test('drops entries without a string id', () => {
    const path = makeTmpFile()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        chats: [chat('c1'), { topic: 'no id' }],
        teams: [],
        channelsByTeam: {},
        savedAt: 'x',
      }),
    )
    expect(loadListCache(path)?.chats.map((c) => c.id)).toEqual(['c1'])
  })
})

describe('serializeListCache caps', () => {
  test('caps chats and teams', () => {
    const snap: ListSnapshot = {
      chats: Array.from({ length: 400 }, (_, i) => chat(`c${i}`)),
      teams: Array.from({ length: 150 }, (_, i) => team(`t${i}`)),
      channelsByTeam: { t0: Array.from({ length: 300 }, (_, i) => channel(`ch${i}`)) },
    }
    const out = serializeListCache(snap)
    expect(out.chats.length).toBe(300)
    expect(out.teams.length).toBe(100)
    expect(out.channelsByTeam.t0!.length).toBe(200)
  })
})

describe('scheduleListCacheSave', () => {
  test('debounces and flushListCache writes the latest snapshot', async () => {
    const path = makeTmpFile()
    const a: ListSnapshot = { chats: [chat('a')], teams: [], channelsByTeam: {} }
    const b: ListSnapshot = { chats: [chat('b')], teams: [], channelsByTeam: {} }
    scheduleListCacheSave(a, 5_000, path)
    scheduleListCacheSave(b, 5_000, path)
    flushListCache()
    expect(loadListCache(path)?.chats.map((c) => c.id)).toEqual(['b'])
  })
})
