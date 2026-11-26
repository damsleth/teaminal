import { accountRef } from '../account'
import { createGraphClient, type AccountContext } from '../graph/client'
import { afterEach, describe, expect, it, mock, setSystemTime } from 'bun:test'
import { statSync, readdirSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isImageAttachment, attachmentGraphPath } from '../types'
import type { MessageAttachment } from '../types'
import {
  __resetForTests as resetClient,
  __setTransportForTests as setClientTransport,
} from '../graph/client'
import {
  __resetForTests as resetAsyncGw,
  __setTransportForTests as setAsyncGwTransport,
} from '../graph/teamsAsyncGw'
import {
  __resetForTests as resetFederation,
  __setTransportForTests as setFederationTransport,
} from '../graph/teamsFederation'
import { __resetForTests as resetRegion, __setRegionForTests } from '../graph/teamsRegion'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __forgetImagesInMemoryForTests,
  __imageMemoryBytesForTests,
  __resetPhotoStateForTests,
  __setImageMemoryBudgetForTests,
  clearImageCache,
  ensureTeamPhoto,
  ensureUserPhoto,
  userPhotoKey,
  ensureImageFetched,
  fetchAndCacheImage,
  fetchExternalImage,
  isPublicImageAddress,
  __setExternalImageTransportForTests,
  getImageCacheDir,
  getImageData,
  getImageStatus,
  imageCacheKey as cacheKey,
  ownedImageKey,
  readCachedImage,
} from './imageCache'

const testClient = (over: Partial<AccountContext> = {}) =>
  createGraphClient({ account: accountRef(undefined), audience: 'graph', fallback: false, ...over })

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
  const realXdg = process.env.XDG_CACHE_HOME
  let cacheRoot: string
  afterEach(() => {
    __setExternalImageTransportForTests()
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
    __setExternalImageTransportForTests(fakeFetch)

    const key = `external-test-${Date.now()}`
    const buf = await fetchAndCacheImage(
      'https://media.giphy.com/test.gif',
      key,
      { contentType: 'image/gif', name: 'test.gif' },
      { isExternal: true, client: testClient() },
    )

    expect(buf).not.toBeNull()
    const dir = getImageCacheDir()
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
    expect(capturedHeaders).not.toBeNull()
    expect(capturedHeaders!.get('authorization')).toBeNull()
    expect(capturedHeaders!.get('Authorization')).toBeNull()
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('sanitizes profile names before using them in cache paths', async () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-profile`)
    process.env.XDG_CACHE_HOME = cacheRoot
    __setExternalImageTransportForTests(
      mock(async () => new Response(new Uint8Array([1]), { status: 200 })),
    )

    const key = `profile-path-test-${Date.now()}`
    await fetchAndCacheImage(
      'https://media.giphy.com/test.gif',
      key,
      { contentType: 'image/gif', name: 'test.gif' },
      {
        isExternal: true,
        client: createGraphClient({
          account: accountRef('../escape/profile'),
          audience: 'graph',
          fallback: false,
        }),
      },
    )

    expect(readCachedImage(key, '../escape/profile')).not.toBeNull()
    expect(existsSync(join(cacheRoot, 'escape'))).toBe(false)
  })
})

describe('fetchAndCacheImage hosted-content routing', () => {
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
    resetFederation()
    resetRegion()
    resetAuth()
    if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = realXdg
    rmSync(cacheRoot, { recursive: true, force: true })
  })

  it('ic3-only routes a hosted-content image to asyncgw, never Graph', async () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-ic3`)
    process.env.XDG_CACHE_HOME = cacheRoot
    setAuthRunner(async () => ({
      stdout: makeJwt({ exp: FAR_FUTURE, oid: 'oid-self' }),
      stderr: '',
      exitCode: 0,
    }))
    // Deterministic skype-token exchange so asyncgw bootstrap uses
    // skypetokenauth (the FOCI-client path) rather than the real network.
    __setRegionForTests(undefined, 'emea')
    setFederationTransport(
      async () =>
        new Response(JSON.stringify({ tokens: { skypeToken: 'skype-test', expiresIn: 3600 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    // Graph transport must never be hit on the ic3-only path.
    setClientTransport(async () => {
      throw new Error('graph transport should not be called for ic3-only image fetch')
    })
    let objectUrl = ''
    setAsyncGwTransport(async (url) => {
      if (url.endsWith('/skypetokenauth')) {
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
      {
        client: testClient({ audience: 'ic3', fallback: false }),
        objectId: '0-na-d2-eb96',
        region: 'amer',
      },
    )
    expect(buf).not.toBeNull()
    expect(buf!.byteLength).toBe(5)
    expect(objectUrl).toContain('https://na-prod.asyncgw.teams.microsoft.com/')
    expect(objectUrl).toContain('/objects/0-na-d2-eb96/views/imgpsh_fullsize')
  })

  it('falls back to asyncgw when Graph 404s a cross-tenant hosted content', async () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-xtenant`)
    process.env.XDG_CACHE_HOME = cacheRoot
    // Default graph audience, audience fallback OFF — the 404 fallback must
    // not depend on it (cross-tenant chats happen on plain accounts).
    setAuthRunner(async () => ({
      stdout: makeJwt({ exp: FAR_FUTURE, oid: 'oid-self' }),
      stderr: '',
      exitCode: 0,
    }))
    __setRegionForTests(undefined, 'emea')
    setFederationTransport(
      async () =>
        new Response(JSON.stringify({ tokens: { skypeToken: 'skype-test', expiresIn: 3600 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    // Graph 404s the hosted content: cross-tenant 1:1 chat, the content is
    // homed in the other tenant.
    let graphCalls = 0
    setClientTransport(async () => {
      graphCalls += 1
      return new Response(JSON.stringify({ error: { message: 'NotFound' } }), { status: 404 })
    })
    let objectUrl = ''
    setAsyncGwTransport(async (url) => {
      if (url.endsWith('/skypetokenauth')) {
        return new Response(null, { status: 200, headers: { 'set-cookie': 'AGW=s1' } })
      }
      objectUrl = url
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    })

    const buf = await fetchAndCacheImage(
      '/chats/chat-x/messages/msg-x/hostedContents/0-nch-d4-8efd/$value',
      `xtenant-test-${Date.now()}`,
      { contentType: '', name: 'image' },
      { client: testClient(), objectId: '0-nch-d4-8efd' },
    )
    expect(buf).not.toBeNull()
    expect(buf!.byteLength).toBe(3)
    expect(graphCalls).toBe(1)
    expect(objectUrl).toContain('/objects/0-nch-d4-8efd/views/imgpsh_fullsize')
  })

  it('falls back to asyncgw when Graph 403s a channel hosted content', async () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-channel`)
    process.env.XDG_CACHE_HOME = cacheRoot
    // Default graph audience, audience fallback OFF — the 403 fallback must
    // not depend on it (channel images 403 on plain graph accounts).
    setAuthRunner(async () => ({
      stdout: makeJwt({ exp: FAR_FUTURE, oid: 'oid-self' }),
      stderr: '',
      exitCode: 0,
    }))
    __setRegionForTests(undefined, 'emea')
    setFederationTransport(
      async () =>
        new Response(JSON.stringify({ tokens: { skypeToken: 'skype-test', expiresIn: 3600 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    // Graph 403s the hosted content: channel (thread.v2) content Graph won't
    // serve, but the asyncgw object store does.
    let graphCalls = 0
    setClientTransport(async () => {
      graphCalls += 1
      return new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 })
    })
    let objectUrl = ''
    setAsyncGwTransport(async (url) => {
      if (url.endsWith('/skypetokenauth')) {
        return new Response(null, { status: 200, headers: { 'set-cookie': 'AGW=s1' } })
      }
      objectUrl = url
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    })

    const buf = await fetchAndCacheImage(
      '/chats/chat-c/messages/msg-c/hostedContents/0-csea-d9-cb8e/$value',
      `channel-test-${Date.now()}`,
      { contentType: '', name: 'image' },
      { client: testClient(), objectId: '0-csea-d9-cb8e' },
    )
    expect(buf).not.toBeNull()
    expect(buf!.byteLength).toBe(3)
    expect(graphCalls).toBe(1)
    expect(objectUrl).toContain('/objects/0-csea-d9-cb8e/views/imgpsh_fullsize')
  })
})

describe('ensureImageFetched disk-cache notification', () => {
  // Redirect the cache to a temp dir: without this the test writes into the
  // developer's real ~/.cache/teaminal (leaving artifacts behind, and failing
  // outright with EPERM where the home cache is read-only). Same pattern as
  // the fetch suites above — getCacheDir() reads process.env per call.
  const realXdg = process.env.XDG_CACHE_HOME
  let cacheRoot = ''

  afterEach(() => {
    if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = realXdg
    if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true })
  })

  it('a disk hit notifies, so a caller showing "loading…" re-renders', async () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-disk-hit`)
    process.env.XDG_CACHE_HOME = cacheRoot
    // The modal fetches on demand and renders a placeholder first; without a
    // notification on the disk-hit path it would stay on that placeholder
    // forever even though the blob is already in hand.
    const key = `disk-hit-${Date.now()}`
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ])
    // Seed the on-disk cache the way the writer lays it out: sha1(key).bin
    // alongside sha1(key).meta.json.
    const dir = getImageCacheDir()
    mkdirSync(dir, { recursive: true })
    const hash = createHash('sha1').update(key).digest('hex')
    writeFileSync(join(dir, `${hash}.bin`), png)
    writeFileSync(
      join(dir, `${hash}.meta.json`),
      JSON.stringify({
        contentType: 'image/png',
        name: 'x.png',
      }),
    )

    let notified = 0
    ensureImageFetched(
      'ignored',
      key,
      { contentType: 'image/png', name: 'x.png' },
      { client: testClient(), onChange: () => notified++ },
    )
    expect(notified).toBe(1)
    expect(getImageData(testClient().ctx.account.id, key)).toEqual(png)

    // The 'ready' guard means a repeat call is a no-op — no render loop.
    ensureImageFetched(
      'ignored',
      key,
      { contentType: 'image/png', name: 'x.png' },
      { client: testClient(), onChange: () => notified++ },
    )
    expect(notified).toBe(1)
  })
})

describe('in-memory image budget', () => {
  const realXdg = process.env.XDG_CACHE_HOME
  let cacheRoot = ''

  afterEach(() => {
    __setImageMemoryBudgetForTests()
    __forgetImagesInMemoryForTests()
    if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = realXdg
    if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true })
  })

  // A 100-byte PNG-looking blob on disk under `key`, filled with `fill`.
  const seed = (key: string, fill: number): Buffer => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(92, fill),
    ])
    const dir = getImageCacheDir()
    mkdirSync(dir, { recursive: true })
    const hash = createHash('sha1').update(key).digest('hex')
    writeFileSync(join(dir, `${hash}.bin`), png)
    writeFileSync(join(dir, `${hash}.meta.json`), JSON.stringify({ contentType: 'image/png' }))
    return png
  }
  const ensure = (key: string, onChange: () => void = () => {}) =>
    ensureImageFetched(
      'ignored',
      key,
      { contentType: 'image/png', name: 'x.png' },
      { client: testClient(), onChange },
    )

  it('evicts the least recently read blob over the budget; it comes back from disk', () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-budget`)
    process.env.XDG_CACHE_HOME = cacheRoot
    __forgetImagesInMemoryForTests()
    __setImageMemoryBudgetForTests(250)
    const me = testClient().ctx.account.id
    const [a, b, c] = ['img-a', 'img-b', 'img-c']
    const pngA = seed(a, 1)
    const pngB = seed(b, 2)
    seed(c, 3)

    ensure(a)
    ensure(b)
    expect(__imageMemoryBytesForTests()).toBe(200)
    // a is on screen (read by the painter), b is not.
    expect(getImageData(me, a)).toEqual(pngA)
    ensure(c)

    expect(__imageMemoryBytesForTests()).toBe(200)
    expect(getImageData(me, a)).toEqual(pngA)
    expect(getImageData(me, b)).toBeUndefined()
    // Not 'ready' with no bytes: the next ensure reloads it.
    expect(getImageStatus(me, b)).toBe('pending')
    let notified = 0
    ensure(b, () => notified++)
    expect(notified).toBe(1)
    expect(getImageData(me, b)).toEqual(pngB)
    expect(__imageMemoryBytesForTests()).toBeLessThanOrEqual(250)
  })

  it('keeps the newest blob even when it alone is over the budget', () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-budget-one`)
    process.env.XDG_CACHE_HOME = cacheRoot
    __forgetImagesInMemoryForTests()
    __setImageMemoryBudgetForTests(50)
    const png = seed('img-big', 4)
    ensure('img-big')
    expect(getImageData(testClient().ctx.account.id, 'img-big')).toEqual(png)
    expect(__imageMemoryBytesForTests()).toBe(100)
  })

  it('a cleared account gives its bytes back to the budget', () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-budget-clear`)
    process.env.XDG_CACHE_HOME = cacheRoot
    __forgetImagesInMemoryForTests()
    seed('img-a', 1)
    ensure('img-a')
    expect(__imageMemoryBytesForTests()).toBe(100)
    clearImageCache(undefined)
    expect(__imageMemoryBytesForTests()).toBe(0)
  })
})

describe('image ownership across accounts', () => {
  const realXdg = process.env.XDG_CACHE_HOME
  let cacheRoot = ''

  afterEach(() => {
    if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = realXdg
    if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true })
  })

  it('the same cache key under two accounts keeps distinct bytes, clears and kitty ids', () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-owners`)
    process.env.XDG_CACHE_HOME = cacheRoot
    const key = cacheKey('msg-1', 'att-1')
    const seed = (profile: string, fill: number) => {
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(16, fill),
      ])
      const dir = getImageCacheDir(profile)
      mkdirSync(dir, { recursive: true })
      const hash = createHash('sha1').update(key).digest('hex')
      writeFileSync(join(dir, `${hash}.bin`), png)
      writeFileSync(join(dir, `${hash}.meta.json`), JSON.stringify({ contentType: 'image/png' }))
      return png
    }
    const pngA = seed('alpha', 1)
    const pngB = seed('beta', 2)
    const a = accountRef('alpha')
    const b = accountRef('beta')
    const clientFor = (account: typeof a) => testClient({ account })
    for (const account of [a, b]) {
      ensureImageFetched(
        'ignored',
        key,
        { contentType: 'image/png', name: 'x.png' },
        { client: clientFor(account), onChange: () => {} },
      )
    }

    expect(getImageData(a.id, key)).toEqual(pngA)
    expect(getImageData(b.id, key)).toEqual(pngB)
    expect(getImageData(undefined, key)).toBeUndefined()
    // Kitty ids are assigned per key string, so distinct owned keys never
    // reuse the other account's transmitted pixels.
    expect(ownedImageKey(a.id, key)).not.toBe(ownedImageKey(b.id, key))

    clearImageCache('alpha')
    expect(getImageData(a.id, key)).toBeUndefined()
    expect(getImageData(b.id, key)).toEqual(pngB)
  })
})

describe('profile photos', () => {
  const realXdg = process.env.XDG_CACHE_HOME
  afterEach(() => {
    resetClient()
    resetAuth()
    __resetPhotoStateForTests()
    __forgetImagesInMemoryForTests()
    if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = realXdg
  })

  // A graph account whose Graph transport answers each photo URL with
  // `respond(url)`; returns the URLs requested.
  function setup(respond: (url: string) => Response): string[] {
    process.env.XDG_CACHE_HOME = join(tmpdir(), `teaminal-cache-${Date.now()}-${Math.random()}`)
    const exp = Math.floor(Date.now() / 1000) + 3600
    const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({ exp, oid: 'oid-self' }),
    ).toString('base64url')}.sig`
    setAuthRunner(async () => ({ stdout: jwt, stderr: '', exitCode: 0 }))
    const urls: string[] = []
    setClientTransport(async (url) => {
      urls.push(String(url))
      return respond(String(url))
    })
    return urls
  }
  const settled = () => new Promise((r) => setTimeout(r, 30))
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])
  const photoUrls = (urls: string[]) => urls.filter((u) => u.includes('/photo'))

  it('a 401 turns user photos off for the account; team pictures still load', async () => {
    const urls = setup((url) =>
      url.includes('/users/')
        ? new Response('{}', { status: 401 })
        : new Response(JPEG, { status: 200 }),
    )
    const opts = { client: testClient(), onChange: () => {} }
    ensureUserPhoto('u1', 48, opts)
    await settled()
    ensureUserPhoto('u2', 48, opts)
    ensureTeamPhoto('t1', opts)
    await settled()
    // u1 is asked (the client retries a 401 once); u2 is never asked.
    expect(photoUrls(urls).filter((u) => u.includes('/u1/')).length).toBeGreaterThan(0)
    expect(photoUrls(urls).filter((u) => u.includes('/u2/'))).toHaveLength(0)
    expect(photoUrls(urls).filter((u) => u.includes('/teams/'))).toHaveLength(1)
  })

  it('a 403 skips only that picture', async () => {
    const urls = setup(() => new Response('{}', { status: 403 }))
    const opts = { client: testClient(), onChange: () => {} }
    ensureUserPhoto('u1', 48, opts)
    await settled()
    ensureUserPhoto('u1', 48, opts)
    ensureUserPhoto('u2', 48, opts)
    await settled()
    expect(photoUrls(urls).filter((u) => u.includes('/u1/'))).toHaveLength(1)
    expect(photoUrls(urls).filter((u) => u.includes('/u2/'))).toHaveLength(1)
  })

  it('cached photos load from disk even when the kind is turned off', async () => {
    const urls = setup((url) =>
      url.includes('/u1/')
        ? new Response(JPEG, { status: 200 })
        : new Response('{}', { status: 401 }),
    )
    const client = testClient()
    ensureUserPhoto('u1', 48, { client, onChange: () => {} })
    await settled()
    ensureUserPhoto('u2', 48, { client, onChange: () => {} }) // 401: user photos off
    await settled()
    __forgetImagesInMemoryForTests() // as after a restart; the 401 block stays
    ensureUserPhoto('u1', 48, { client, onChange: () => {} })
    expect(getImageData(client.ctx.account.id, userPhotoKey('u1', 48))).toBeDefined()
    expect(photoUrls(urls).filter((u) => u.includes('/u1/'))).toHaveLength(1)
  })

  it('a 404 is remembered on disk, so the next launch does not ask again', async () => {
    const urls = setup(() => new Response('{}', { status: 404 }))
    const client = testClient()
    ensureUserPhoto('nobody', 48, { client, onChange: () => {} })
    await settled()
    __forgetImagesInMemoryForTests()
    ensureUserPhoto('nobody', 48, { client, onChange: () => {} })
    await settled()
    expect(photoUrls(urls)).toHaveLength(1)
  })

  it('every caller waiting on a picture is told when it lands', async () => {
    setup(() => new Response(JPEG, { status: 200 }))
    const client = testClient()
    let list = 0
    let pane = 0
    ensureUserPhoto('u1', 48, { client, onChange: () => list++ })
    ensureUserPhoto('u1', 48, { client, onChange: () => pane++ })
    await settled()
    expect([list, pane]).toEqual([1, 1])
  })

  it('at most 4 photo requests run at once per account', async () => {
    let active = 0
    let peak = 0
    process.env.XDG_CACHE_HOME = join(tmpdir(), `teaminal-cache-${Date.now()}-q`)
    setup(() => new Response(JPEG, { status: 200 }))
    setClientTransport(async () => {
      peak = Math.max(peak, ++active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return new Response(JPEG, { status: 200 })
    })
    const client = testClient()
    for (let i = 0; i < 10; i++) ensureUserPhoto(`q${i}`, 48, { client, onChange: () => {} })
    await new Promise((r) => setTimeout(r, 120))
    expect(peak).toBeLessThanOrEqual(4)
  })
})

describe('external image security', () => {
  afterEach(() => {
    __setExternalImageTransportForTests()
  })

  it('rejects unsafe schemes, IP literals and local hosts before fetching', async () => {
    const transport = mock(async () => new Response(''))
    __setExternalImageTransportForTests(transport)
    for (const url of [
      'http://example.com/a',
      'https://127.0.0.1/a',
      'https://100.64.0.1/a',
      'https://[::1]/a',
      'https://localhost/a',
      'https://localhost./a',
      'https://example.local/a',
      'https://2130706433/a',
    ]) {
      await expect(fetchExternalImage(url)).rejects.toThrow()
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('disables redirects and preserves small images', async () => {
    __setExternalImageTransportForTests(
      mock(async (_url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe('error')
        return new Response(new Uint8Array([1, 2]))
      }),
    )
    expect(await fetchExternalImage('https://example.com/a')).toEqual(Buffer.from([1, 2]))
  })

  it('cancels oversized bodies from Content-Length before reading', async () => {
    let cancelled = false
    __setExternalImageTransportForTests(
      mock(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true
              },
            }),
            { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } },
          ),
      ),
    )
    await expect(fetchExternalImage('https://example.com/a')).rejects.toThrow('too large')
    expect(cancelled).toBe(true)
  })

  it('cancels a stream exceeding the cap even with a false Content-Length', async () => {
    let cancelled = false
    let reads = 0
    __setExternalImageTransportForTests(
      mock(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                reads++
                controller.enqueue(new Uint8Array(1024 * 1024))
              },
              cancel() {
                cancelled = true
              },
            }),
            { headers: { 'content-length': '1' } },
          ),
      ),
    )
    await expect(fetchExternalImage('https://example.com/a')).rejects.toThrow('too large')
    expect(cancelled).toBe(true)
    expect(reads).toBeLessThanOrEqual(6)
  })
})

it('rejects private DNS results including IPv4 mapped IPv6', () => {
  for (const [address, family] of [
    ['127.0.0.1', 4],
    ['100.64.0.1', 4],
    ['::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['fe80::1', 6],
    ['fc00::1', 6],
  ] as const) {
    expect(isPublicImageAddress(address, family)).toBe(false)
  }
})

it('rejects redirect responses without making another request', async () => {
  const transport = mock(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/a' },
      }),
  )
  __setExternalImageTransportForTests(transport)
  try {
    await expect(fetchExternalImage('https://example.com/a')).rejects.toThrow('302')
    expect(transport).toHaveBeenCalledTimes(1)
  } finally {
    __setExternalImageTransportForTests()
  }
})

describe('inline image fetch: shared waiters and retry', () => {
  const realXdg = process.env.XDG_CACHE_HOME
  let cacheRoot = ''
  afterEach(() => {
    __setExternalImageTransportForTests()
    setSystemTime()
    if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = realXdg
    if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true })
  })

  it('tells every waiting caller, and retries a failure after a delay', async () => {
    cacheRoot = join(tmpdir(), `teaminal-cache-${Date.now()}-inline-retry`)
    process.env.XDG_CACHE_HOME = cacheRoot
    let calls = 0
    let settle!: (r: Response) => void
    __setExternalImageTransportForTests(
      mock(() => {
        calls++
        return new Promise<Response>((r) => (settle = r))
      }),
    )
    const key = `inline-retry-${Date.now()}`
    const meta = { contentType: 'image/png', name: 'x.png' }
    const fetchIt = (onChange: () => void) =>
      ensureImageFetched('https://example.com/x.png', key, meta, {
        client: testClient(),
        isExternal: true,
        onChange,
      })
    let a = 0
    let b = 0
    fetchIt(() => a++)
    fetchIt(() => b++)
    for (let i = 0; i < 50 && calls === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(calls).toBe(1)
    settle(new Response('nope', { status: 500 }))
    for (let i = 0; i < 100 && a === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect([a, b]).toEqual([1, 1])

    // Within the retry window a failure is not refetched (no render loop)...
    fetchIt(() => {})
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).toBe(1)
    // ...after it, the next caller fetches again.
    setSystemTime(new Date(Date.now() + 5 * 60_000))
    fetchIt(() => {})
    for (let i = 0; i < 50 && calls === 1; i++) await new Promise((r) => setTimeout(r, 5))
    expect(calls).toBe(2)
  })
})
