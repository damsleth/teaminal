import { afterEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isImageAttachment, attachmentGraphPath } from '../types'
import type { MessageAttachment } from '../types'
import {
  __resetForTests as resetClient,
  __setTransportForTests as setClientTransport,
  setAudiencePreference,
} from '../graph/client'
import {
  __resetForTests as resetAsyncGw,
  __setTransportForTests as setAsyncGwTransport,
} from '../graph/teamsAsyncGw'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { fetchAndCacheImage, imageCacheKey as cacheKey, readCachedImage } from './imageCache'

describe('imageCacheKey', () => {
  it('combines messageId and attachmentId with ::', () => {
    expect(cacheKey('msg-1', 'att-2')).toBe('msg-1::att-2')
  })

  it('never contains the attachment URL (no credential leak)', () => {
    const key = cacheKey('msg-abc', 'att-xyz')
    expect(key).not.toContain('https://')
    expect(key).not.toContain('token')
  })
})

describe('isImageAttachment', () => {
  const att = (contentType: string, name?: string): MessageAttachment => ({
    id: 'x',
    contentType,
    name: name ?? null,
  })

  it('matches explicit image/* MIME types', () => {
    expect(isImageAttachment(att('image/png'))).toBe(true)
    expect(isImageAttachment(att('image/jpeg'))).toBe(true)
    expect(isImageAttachment(att('image/gif'))).toBe(true)
    expect(isImageAttachment(att('image/webp'))).toBe(true)
  })

  it('matches by filename extension for Teams hosted content', () => {
    expect(
      isImageAttachment(att('application/vnd.microsoft.teams.file.download.info', 'photo.png')),
    ).toBe(true)
    expect(isImageAttachment(att('reference', 'screenshot.jpeg'))).toBe(true)
    expect(isImageAttachment(att('reference', 'diagram.svg'))).toBe(true)
  })

  it('does not match non-image MIME types without image extension', () => {
    expect(isImageAttachment(att('application/pdf', 'report.pdf'))).toBe(false)
    expect(isImageAttachment(att('text/plain', 'notes.txt'))).toBe(false)
    expect(isImageAttachment(att('application/vnd.ms-excel', 'data.xlsx'))).toBe(false)
  })
})

describe('attachmentGraphPath', () => {
  const chatId = 'chat-abc'
  const msgId = 'msg-def'

  it('strips the Graph v1 base from a contentUrl', () => {
    const att: MessageAttachment = {
      id: 'att-1',
      contentType: 'image/png',
      contentUrl:
        'https://graph.microsoft.com/v1.0/chats/chat-abc/messages/msg-def/hostedContents/att-1/$value',
    }
    const path = attachmentGraphPath(att, chatId, msgId)
    expect(path).toBe('/chats/chat-abc/messages/msg-def/hostedContents/att-1/$value')
    expect(path).not.toContain('https://graph.microsoft.com')
  })

  it('falls back to hostedContents path when contentUrl is null', () => {
    const att: MessageAttachment = {
      id: 'att-99',
      contentType: 'reference',
      contentUrl: null,
      name: 'image.png',
    }
    const path = attachmentGraphPath(att, chatId, msgId)
    expect(path).toContain('/hostedContents/')
    expect(path).toContain('att-99')
    expect(path).toEndWith('/$value')
  })

  it('URL-encodes special chars in IDs', () => {
    const att: MessageAttachment = {
      id: 'att with spaces',
      contentType: 'image/jpeg',
      contentUrl: null,
    }
    const path = attachmentGraphPath(att, 'chat/id', 'msg/id')
    expect(path).not.toContain(' ')
    expect(path).toContain('att%20with%20spaces')
  })
})

describe('fetchAndCacheImage isExternal branch', () => {
  const realFetch = globalThis.fetch
  const realXdg = process.env.XDG_CACHE_HOME
  let cacheRoot: string
  afterEach(() => {
    globalThis.fetch = realFetch
    if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = realXdg
    rmSync(cacheRoot, { recursive: true, force: true })
  })

  it('does not send Authorization when isExternal is true', async () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-external`)
    process.env.XDG_CACHE_HOME = cacheRoot
    let capturedHeaders: Headers | null = null
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fakeFetch = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers ?? {})
      return new Response(bytes, { status: 200 })
    })
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    const key = `external-test-${Date.now()}`
    const buf = await fetchAndCacheImage(
      'https://media.giphy.com/test.gif',
      key,
      { contentType: 'image/gif', name: 'test.gif' },
      { isExternal: true, profile: '__external_test__' },
    )

    expect(buf).not.toBeNull()
    expect(capturedHeaders).not.toBeNull()
    expect(capturedHeaders!.get('authorization')).toBeNull()
    expect(capturedHeaders!.get('Authorization')).toBeNull()
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('sanitizes profile names before using them in cache paths', async () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-profile`)
    process.env.XDG_CACHE_HOME = cacheRoot
    globalThis.fetch = mock(
      async () => new Response(new Uint8Array([1]), { status: 200 }),
    ) as unknown as typeof fetch

    const key = `profile-path-test-${Date.now()}`
    await fetchAndCacheImage(
      'https://media.giphy.com/test.gif',
      key,
      { contentType: 'image/gif', name: 'test.gif' },
      { isExternal: true, profile: '../escape/profile' },
    )

    expect(readCachedImage(key, '../escape/profile')).not.toBeNull()
    expect(existsSync(join(cacheRoot, 'escape'))).toBe(false)
  })
})

describe('fetchAndCacheImage hosted-content routing (ic3)', () => {
  const realXdg = process.env.XDG_CACHE_HOME
  const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600
  let cacheRoot: string

  function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${header}.${body}.sig`
  }

  afterEach(() => {
    resetClient()
    resetAsyncGw()
    resetAuth()
    if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = realXdg
    rmSync(cacheRoot, { recursive: true, force: true })
  })

  it('ic3-only routes a hosted-content image to asyncgw, never Graph', async () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-ic3`)
    process.env.XDG_CACHE_HOME = cacheRoot
    setAudiencePreference('ic3', { fallback: false })
    setAuthRunner(async () => ({
      stdout: makeJwt({ exp: FAR_FUTURE, oid: 'oid-self' }),
      stderr: '',
      exitCode: 0,
    }))
    // Graph transport must never be hit on the ic3-only path.
    setClientTransport(async () => {
      throw new Error('graph transport should not be called for ic3-only image fetch')
    })
    let objectUrl = ''
    setAsyncGwTransport(async (url) => {
      if (url.endsWith('/aadtokenauth')) {
        return new Response(null, { status: 200, headers: { 'set-cookie': 'AGW=s1' } })
      }
      objectUrl = url
      return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    })

    const buf = await fetchAndCacheImage(
      '/chats/chat-1/messages/msg-1/hostedContents/AAA/$value',
      `ic3-test-${Date.now()}`,
      { contentType: '', name: 'image' },
      { profile: '__ic3_test__', objectId: '0-wch-d2-eb96' },
    )
    expect(buf).not.toBeNull()
    expect(buf!.byteLength).toBe(5)
    expect(objectUrl).toContain('/objects/0-wch-d2-eb96/views/imgpsh_fullsize')
  })
})
