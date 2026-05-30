import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getNameCachePath, loadNameCache, saveNameCacheNow } from './nameCachePersistence'

const tmpDirs: string[] = []

function makeTmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teaminal-namecache-'))
  tmpDirs.push(dir)
  return join(dir, 'names.json')
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe('getNameCachePath profile scoping', () => {
  test('default profile uses the bare path', () => {
    expect(getNameCachePath({ HOME: '/tmp/home', XDG_CACHE_HOME: '/tmp/cache' }, null)).toBe(
      '/tmp/cache/teaminal/names.json',
    )
  })

  test('named profile is slugified into the filename', () => {
    expect(getNameCachePath({ XDG_CACHE_HOME: '/tmp/cache' }, 'crayon/work')).toBe(
      '/tmp/cache/teaminal/names.crayon_work.json',
    )
  })
})

describe('name cache round-trip', () => {
  test('saves and loads the index', () => {
    const path = makeTmpFile()
    saveNameCacheNow({ 'u-a': 'Anna Aas', 'u-b': 'Bjørn Hansen' }, path)
    expect(loadNameCache(path)).toEqual({ 'u-a': 'Anna Aas', 'u-b': 'Bjørn Hansen' })
  })

  test('returns empty for a missing file', () => {
    expect(loadNameCache(makeTmpFile())).toEqual({})
  })

  test('ignores a version mismatch', () => {
    const path = makeTmpFile()
    writeFileSync(path, JSON.stringify({ version: 999, names: { 'u-a': 'Anna' } }))
    expect(loadNameCache(path)).toEqual({})
  })

  test('drops malformed entries', () => {
    const path = makeTmpFile()
    writeFileSync(
      path,
      JSON.stringify({ version: 1, names: { 'u-a': 'Anna', 'u-b': '', 'u-c': 42 } }),
    )
    expect(loadNameCache(path)).toEqual({ 'u-a': 'Anna' })
  })
})
