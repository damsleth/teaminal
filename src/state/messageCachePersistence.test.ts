import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flushMessageCache,
  loadMessageCache,
  saveMessageCacheNow,
  scheduleMessageCacheSave,
  serializeMessageCache,
} from './messageCachePersistence'
import type { MessageCache } from './store'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  tmpDirs.length = 0
})

function makeTmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teaminal-msgcache-'))
  tmpDirs.push(dir)
  return join(dir, 'messages.json')
}

function makeMessage(
  id: string,
  opts?: { sending?: boolean; sendError?: string },
): {
  id: string
  createdDateTime: string
  body: { contentType: 'text'; content: string }
  messageType: 'message'
  _sending?: boolean
  _sendError?: string
} {
  return {
    id,
    createdDateTime: '2026-01-01T00:00:00Z',
    body: { contentType: 'text', content: id },
    messageType: 'message',
    ...(opts?.sending ? { _sending: true } : {}),
    ...(opts?.sendError ? { _sendError: opts.sendError } : {}),
  }
}

describe('serializeMessageCache', () => {
  test('strips optimistic and failed messages', () => {
    const caches: Record<string, MessageCache> = {
      'chat:c1': {
        messages: [
          makeMessage('m1') as never,
          makeMessage('m2', { sending: true }) as never,
          makeMessage('m3', { sendError: 'boom' }) as never,
          makeMessage('m4') as never,
        ],
        loadingOlder: false,
        fullyLoaded: false,
        nextLink: 'https://example/next',
      },
    }
    const file = serializeMessageCache(caches)
    expect(file.version).toBe(1)
    expect(file.caches['chat:c1']?.messages.map((m) => m.id)).toEqual(['m1', 'm4'])
    expect(file.caches['chat:c1']?.nextLink).toBe('https://example/next')
    expect(file.caches['chat:c1']?.fullyLoaded).toBe(false)
  })

  test('drops conversations whose messages are all optimistic', () => {
    const caches: Record<string, MessageCache> = {
      'chat:c1': {
        messages: [makeMessage('m1', { sending: true }) as never],
        loadingOlder: false,
        fullyLoaded: false,
      },
    }
    const file = serializeMessageCache(caches)
    expect(file.caches).toEqual({})
  })

  test('caps per-conversation messages to the most recent 200', () => {
    const messages = Array.from({ length: 250 }, (_, i) => makeMessage(`m${i}`) as never)
    const caches: Record<string, MessageCache> = {
      'chat:c1': { messages, loadingOlder: false, fullyLoaded: false },
    }
    const file = serializeMessageCache(caches)
    const stored = file.caches['chat:c1']?.messages ?? []
    expect(stored).toHaveLength(200)
    expect(stored[0]?.id).toBe('m50')
    expect(stored[stored.length - 1]?.id).toBe('m249')
  })
})

describe('saveMessageCacheNow / loadMessageCache', () => {
  test('round-trips a non-empty cache', () => {
    const path = makeTmpFile()
    const caches: Record<string, MessageCache> = {
      'chat:c1': {
        messages: [makeMessage('m1') as never, makeMessage('m2') as never],
        nextLink: 'https://graph/next',
        loadingOlder: false,
        fullyLoaded: false,
      },
    }
    saveMessageCacheNow(caches, path)
    expect(existsSync(path)).toBe(true)
    const loaded = loadMessageCache(path)
    expect(loaded['chat:c1']?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(loaded['chat:c1']?.nextLink).toBe('https://graph/next')
    expect(loaded['chat:c1']?.loadingOlder).toBe(false)
  })

  test('returns empty object when file is missing', () => {
    const path = makeTmpFile()
    expect(loadMessageCache(path)).toEqual({})
  })

  test('ignores corrupted JSON', () => {
    const path = makeTmpFile()
    writeFileSync(path, '{not json')
    expect(loadMessageCache(path)).toEqual({})
  })

  test('ignores file with wrong version', () => {
    const path = makeTmpFile()
    writeFileSync(path, JSON.stringify({ version: 999, caches: {} }))
    expect(loadMessageCache(path)).toEqual({})
  })

  test('forces loadingOlder back to false on hydration', () => {
    const path = makeTmpFile()
    const caches: Record<string, MessageCache> = {
      'chat:c1': {
        messages: [makeMessage('m1') as never],
        loadingOlder: true,
        fullyLoaded: false,
      },
    }
    saveMessageCacheNow(caches, path)
    expect(loadMessageCache(path)['chat:c1']?.loadingOlder).toBe(false)
  })

  test('cleans up the tmp file when rename fails', () => {
    // Point the path at a directory that exists but is not writable as a
    // file (use a directory path itself — renameSync onto an existing
    // non-empty directory throws).
    const dir = mkdtempSync(join(tmpdir(), 'teaminal-msgcache-fail-'))
    tmpDirs.push(dir)
    const blockingDir = join(dir, 'messages.json')
    mkdtempSync(blockingDir + '-x') // unrelated
    require('node:fs').mkdirSync(blockingDir)
    require('node:fs').writeFileSync(join(blockingDir, 'occupant'), 'x')
    const caches: Record<string, MessageCache> = {
      'chat:c1': {
        messages: [makeMessage('m1') as never],
        loadingOlder: false,
        fullyLoaded: false,
      },
    }
    expect(() => saveMessageCacheNow(caches, blockingDir)).toThrow()
    // No leftover .messages.json.<pid>.<ts>.tmp files in the parent dir.
    const stragglers = require('node:fs')
      .readdirSync(dir)
      .filter((f: string) => f.startsWith('.messages.json.'))
    expect(stragglers).toEqual([])
  })
})

describe('scheduleMessageCacheSave', () => {
  test('debounces and flushMessageCache writes the latest snapshot', async () => {
    const path = makeTmpFile()
    const cachesA: Record<string, MessageCache> = {
      'chat:c1': {
        messages: [makeMessage('m1') as never],
        loadingOlder: false,
        fullyLoaded: false,
      },
    }
    const cachesB: Record<string, MessageCache> = {
      'chat:c1': {
        messages: [makeMessage('m1') as never, makeMessage('m2') as never],
        loadingOlder: false,
        fullyLoaded: false,
      },
    }
    scheduleMessageCacheSave(cachesA, 5_000, path)
    scheduleMessageCacheSave(cachesB, 5_000, path)
    expect(existsSync(path)).toBe(false)
    flushMessageCache()
    expect(existsSync(path)).toBe(true)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.caches['chat:c1'].messages.map((m: { id: string }) => m.id)).toEqual([
      'm1',
      'm2',
    ])
  })
})
