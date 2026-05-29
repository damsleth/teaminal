import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearProfileCaches } from './cacheClear'
import { getImageCacheDir } from './imageCache'
import { getListCachePath } from './listCachePersistence'
import { getMessageCachePath } from './messageCachePersistence'

let cacheRoot: string
let prevXdg: string | undefined

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'teaminal-clear-'))
  prevXdg = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = cacheRoot
})

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = prevXdg
  try {
    rmSync(cacheRoot, { recursive: true, force: true })
  } catch {}
})

function seedProfile(profile: string | null): void {
  const env = process.env
  mkdirSync(join(cacheRoot, 'teaminal'), { recursive: true })
  writeFileSync(getMessageCachePath(env, profile), '{"version":1,"caches":{}}')
  writeFileSync(getListCachePath(env, profile), '{"version":1,"chats":[],"teams":[]}')
  const imgDir = getImageCacheDir(profile)
  mkdirSync(imgDir, { recursive: true })
  writeFileSync(join(imgDir, 'abc.bin'), 'blob')
}

describe('clearProfileCaches', () => {
  test('removes the active profile message, list, and image caches', () => {
    seedProfile('work')
    const result = clearProfileCaches('work')
    expect(existsSync(getMessageCachePath(process.env, 'work'))).toBe(false)
    expect(existsSync(getListCachePath(process.env, 'work'))).toBe(false)
    expect(existsSync(getImageCacheDir('work'))).toBe(false)
    expect(result.removed.length).toBe(3)
  })

  test('leaves another profile untouched', () => {
    seedProfile('work')
    seedProfile('home')
    clearProfileCaches('work')
    expect(existsSync(getMessageCachePath(process.env, 'home'))).toBe(true)
    expect(existsSync(getListCachePath(process.env, 'home'))).toBe(true)
    expect(existsSync(getImageCacheDir('home'))).toBe(true)
  })

  test('is a no-op (no throw) when nothing is cached', () => {
    const result = clearProfileCaches(null)
    expect(result.removed).toEqual([])
  })

  test('clears the default profile when profile is null', () => {
    seedProfile(null)
    const result = clearProfileCaches(null)
    expect(existsSync(getMessageCachePath(process.env, null))).toBe(false)
    expect(result.removed.length).toBe(3)
  })
})
