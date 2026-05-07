import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests,
  __setSleepForTests,
  __setTransportForTests,
  graph,
  GraphError,
  paginate,
  paginateAll,
  parseRetryAfter,
  RateLimitError,
  setActiveProfile,
} from './client'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

afterEach(() => {
  __resetForTests()
  resetAuth()
})

function primeAuth(token = makeJwt({ exp: FAR_FUTURE })): void {
  setAuthRunner(async () => ({ stdout: token, stderr: '', exitCode: 0 }))
}

describe('graph success path', () => {
  test('returns parsed JSON body', async () => {
    primeAuth()
    __setTransportForTests(async () => jsonResponse({ id: 'abc', displayName: 'Carl' }))
    const me = await graph<{ id: string; displayName: string }>({
      method: 'GET',
      path: '/me',
    })
    expect(me).toEqual({ id: 'abc', displayName: 'Carl' })
  })

  test('builds URL with v1.0 base and path', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({})
    })
    await graph({ method: 'GET', path: '/me' })
    expect(seenUrl).toBe('https://graph.microsoft.com/v1.0/me')
  })

  test('uses beta base when opts.beta is true', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({})
    })
    await graph({ method: 'GET', path: '/teamwork', beta: true })
    expect(seenUrl).toBe('https://graph.microsoft.com/beta/teamwork')
  })

  test('appends query params, skipping undefined values', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({})
    })
    await graph({
      method: 'GET',
      path: '/chats',
      query: { $top: 50, $expand: 'lastMessagePreview', $skip: undefined },
    })
    expect(seenUrl).toBe(
      'https://graph.microsoft.com/v1.0/chats?%24top=50&%24expand=lastMessagePreview',
    )
  })

  test('injects Bearer token from owa-piggy', async () => {
    const token = makeJwt({ exp: FAR_FUTURE, sub: 'whoami' })
    primeAuth(token)
    let seenAuth = ''
    __setTransportForTests(async (_url, init) => {
      const headers = new Headers(init.headers)
      seenAuth = headers.get('authorization') ?? ''
      return jsonResponse({})
    })
    await graph({ method: 'GET', path: '/me' })
    expect(seenAuth).toBe(`Bearer ${token}`)
  })

  test('serializes object body as JSON with content-type header', async () => {
    primeAuth()
    let seenBody = ''
    let seenContentType = ''
    __setTransportForTests(async (_url, init) => {
      seenBody = typeof init.body === 'string' ? init.body : ''
      seenContentType = new Headers(init.headers).get('content-type') ?? ''
      return jsonResponse({ ok: true })
    })
    await graph({
      method: 'POST',
      path: '/chats/x/messages',
      body: { body: { contentType: 'text', content: 'hi' } },
    })
    expect(JSON.parse(seenBody)).toEqual({ body: { contentType: 'text', content: 'hi' } })
    expect(seenContentType).toBe('application/json')
  })

  test('forwards string body verbatim without setting content-type', async () => {
    primeAuth()
    let seenBody = ''
    let seenContentType: string | null = ''
    __setTransportForTests(async (_url, init) => {
      seenBody = typeof init.body === 'string' ? init.body : ''
      seenContentType = new Headers(init.headers).get('content-type')
      return jsonResponse({ ok: true })
    })
    await graph({ method: 'POST', path: '/raw', body: 'plain-text' })
    expect(seenBody).toBe('plain-text')
    expect(seenContentType).toBeNull()
  })

  test('returns undefined for 204 No Content', async () => {
    primeAuth()
    __setTransportForTests(async () => new Response(null, { status: 204 }))
    const result = await graph({ method: 'DELETE', path: '/chats/x/messages/y' })
    expect(result).toBeUndefined()
  })

  test('forwards AbortSignal to the transport', async () => {
    primeAuth()
    let seenSignal: AbortSignal | undefined
    __setTransportForTests(async (_url, init) => {
      seenSignal = init.signal ?? undefined
      return jsonResponse({})
    })
    const ctrl = new AbortController()
    await graph({ method: 'GET', path: '/me', signal: ctrl.signal })
    expect(seenSignal).toBe(ctrl.signal)
  })

  test('passes activeProfile through to owa-piggy', async () => {
    let seenArgs: string[] = []
    setAuthRunner(async (args) => {
      seenArgs = args
      return { stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }
    })
    __setTransportForTests(async () => jsonResponse({}))
    setActiveProfile('work')
    await graph({ method: 'GET', path: '/me' })
    expect(seenArgs).toEqual(['token', '--audience', 'graph', '--profile', 'work'])
  })

  test('passes explicit scopes through to owa-piggy', async () => {
    let seenArgs: string[] = []
    setAuthRunner(async (args) => {
      seenArgs = args
      return { stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }
    })
    __setTransportForTests(async () => jsonResponse({}))
    setActiveProfile('work')
    await graph({
      method: 'GET',
      path: '/teams/t/channels/c/messages',
      scope: 'https://graph.microsoft.com/ChannelMessage.Read.All',
    })
    expect(seenArgs).toEqual([
      'token',
      '--scope',
      'https://graph.microsoft.com/ChannelMessage.Read.All',
      '--profile',
      'work',
    ])
  })
})

describe('401 handling', () => {
  test('invalidates the token and retries once on 401, then returns the second response', async () => {
    const t1 = makeJwt({ exp: FAR_FUTURE, jti: 'one' })
    const t2 = makeJwt({ exp: FAR_FUTURE, jti: 'two' })
    const tokens = [t1, t2]
    let runnerCalls = 0
    setAuthRunner(async () => {
      const out = tokens[runnerCalls++] ?? t2
      return { stdout: out, stderr: '', exitCode: 0 }
    })

    let httpCalls = 0
    const seenAuth: string[] = []
    __setTransportForTests(async (_url, init) => {
      httpCalls++
      const auth = new Headers(init.headers).get('authorization') ?? ''
      seenAuth.push(auth)
      if (httpCalls === 1) {
        return jsonResponse(
          { error: { code: 'InvalidAuthenticationToken', message: 'expired' } },
          { status: 401 },
        )
      }
      return jsonResponse({ id: 'me' })
    })

    const me = await graph<{ id: string }>({ method: 'GET', path: '/me' })
    expect(me).toEqual({ id: 'me' })
    expect(httpCalls).toBe(2)
    expect(runnerCalls).toBe(2)
    expect(seenAuth[0]).toBe(`Bearer ${t1}`)
    expect(seenAuth[1]).toBe(`Bearer ${t2}`)
  })

  test('throws GraphError(401) on second consecutive 401 (no infinite loop)', async () => {
    primeAuth()
    let httpCalls = 0
    __setTransportForTests(async () => {
      httpCalls++
      return jsonResponse(
        { error: { code: 'InvalidAuthenticationToken', message: 'still no good' } },
        { status: 401 },
      )
    })

    const err = await graph({ method: 'GET', path: '/me' }).catch((e) => e)
    expect(err).toBeInstanceOf(GraphError)
    expect((err as GraphError).status).toBe(401)
    expect((err as GraphError).message).toMatch(/still no good/)
    expect(httpCalls).toBe(2)
  })
})

describe('429 handling', () => {
  test('respects integer-seconds Retry-After and retries', async () => {
    primeAuth()
    let waited = -1
    __setSleepForTests(async (ms) => {
      waited = ms
    })
    let httpCalls = 0
    __setTransportForTests(async () => {
      httpCalls++
      if (httpCalls === 1) {
        return new Response('throttled', {
          status: 429,
          headers: { 'retry-after': '2' },
        })
      }
      return jsonResponse({ value: [] })
    })

    await graph({ method: 'GET', path: '/chats' })
    // 2 seconds = 2000ms ±20% jitter
    expect(waited).toBeGreaterThanOrEqual(1600)
    expect(waited).toBeLessThanOrEqual(2400)
    expect(httpCalls).toBe(2)
  })

  test('respects HTTP-date Retry-After', async () => {
    primeAuth()
    let waited = -1
    __setSleepForTests(async (ms) => {
      waited = ms
    })
    const futureMs = Date.now() + 5000
    const httpDate = new Date(futureMs).toUTCString()
    let httpCalls = 0
    __setTransportForTests(async () => {
      httpCalls++
      if (httpCalls === 1) {
        return new Response('throttled', {
          status: 429,
          headers: { 'retry-after': httpDate },
        })
      }
      return jsonResponse({ value: [] })
    })

    await graph({ method: 'GET', path: '/chats' })
    expect(waited).toBeGreaterThan(0)
    // Allow generous slack since the parse uses Date.now() at request time
    expect(waited).toBeLessThanOrEqual(7000)
    expect(httpCalls).toBe(2)
  })

  test('falls back to default backoff when Retry-After is missing', async () => {
    primeAuth()
    let waited = -1
    __setSleepForTests(async (ms) => {
      waited = ms
    })
    let httpCalls = 0
    __setTransportForTests(async () => {
      httpCalls++
      if (httpCalls === 1) return new Response('throttled', { status: 429 })
      return jsonResponse({ value: [] })
    })

    await graph({ method: 'GET', path: '/chats' })
    // default 1000ms ±20%
    expect(waited).toBeGreaterThanOrEqual(800)
    expect(waited).toBeLessThanOrEqual(1200)
  })

  test('throws RateLimitError after MAX_429_RETRIES (3)', async () => {
    primeAuth()
    __setSleepForTests(async () => {})
    let httpCalls = 0
    __setTransportForTests(async () => {
      httpCalls++
      return new Response('throttled', { status: 429, headers: { 'retry-after': '0' } })
    })

    const err = await graph({ method: 'GET', path: '/chats' }).catch((e) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).status).toBe(429)
    // initial + 3 retries = 4 attempts total
    expect(httpCalls).toBe(4)
  })
})

describe('parseRetryAfter helper', () => {
  test('parses integer seconds', () => {
    expect(parseRetryAfter('5', Date.now())).toBe(5000)
  })

  test('parses fractional seconds', () => {
    expect(parseRetryAfter('1.5', Date.now())).toBe(1500)
  })

  test('parses HTTP-date relative to now', () => {
    const now = Date.now()
    const future = new Date(now + 3000).toUTCString()
    const ms = parseRetryAfter(future, now)
    // HTTP-date has second precision so allow ±1500ms slack
    expect(Math.abs(ms - 3000)).toBeLessThan(1500)
  })

  test('returns 0 for missing or unparseable values', () => {
    expect(parseRetryAfter(null, Date.now())).toBe(0)
    expect(parseRetryAfter('', Date.now())).toBe(0)
    expect(parseRetryAfter('-5', Date.now())).toBe(0)
    expect(parseRetryAfter('garbage', Date.now())).toBe(0)
  })
})

describe('error body parsing', () => {
  test('extracts {error.message} from JSON Graph error', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse(
        {
          error: {
            code: 'Forbidden',
            message: 'Insufficient privileges to complete the operation.',
          },
        },
        { status: 403 },
      ),
    )
    const err = await graph({ method: 'GET', path: '/anything' }).catch((e) => e)
    expect(err).toBeInstanceOf(GraphError)
    expect((err as GraphError).status).toBe(403)
    expect((err as GraphError).message).toMatch(/Insufficient privileges/)
  })

  test('uses plain-text body when error is not JSON', async () => {
    primeAuth()
    __setTransportForTests(
      async () => new Response('Service temporarily unavailable', { status: 503 }),
    )
    const err = await graph({ method: 'GET', path: '/anything' }).catch((e) => e)
    expect(err).toBeInstanceOf(GraphError)
    expect((err as GraphError).message).toMatch(/Service temporarily unavailable/)
  })

  test('falls back to statusText when body is empty', async () => {
    primeAuth()
    __setTransportForTests(async () => new Response('', { status: 502, statusText: 'Bad Gateway' }))
    const err = await graph({ method: 'GET', path: '/anything' }).catch((e) => e)
    expect(err).toBeInstanceOf(GraphError)
    expect((err as GraphError).message).toMatch(/Bad Gateway/)
  })

  test('does not throw while parsing the error body', async () => {
    primeAuth()
    __setTransportForTests(
      () =>
        new Promise<Response>((resolve) => {
          // body is malformed JSON
          resolve(new Response('{"oh no', { status: 500 }))
        }),
    )
    const err = await graph({ method: 'GET', path: '/anything' }).catch((e) => e)
    expect(err).toBeInstanceOf(GraphError)
    expect((err as GraphError).status).toBe(500)
  })
})

describe('paginate', () => {
  test('follows @odata.nextLink until exhausted', async () => {
    primeAuth()
    const seenUrls: string[] = []
    __setTransportForTests(async (url) => {
      seenUrls.push(url)
      if (url.includes('skip=2')) {
        return jsonResponse({ value: [{ id: 'c' }] })
      }
      if (url.includes('skip=1')) {
        return jsonResponse({
          value: [{ id: 'b' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/chats?skip=2',
        })
      }
      return jsonResponse({
        value: [{ id: 'a' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/chats?skip=1',
      })
    })

    const ids: string[] = []
    for await (const page of paginate<{ id: string }>({ method: 'GET', path: '/chats' })) {
      for (const item of page) ids.push(item.id)
    }
    expect(ids).toEqual(['a', 'b', 'c'])
    expect(seenUrls).toHaveLength(3)
    expect(seenUrls[1]).toBe('https://graph.microsoft.com/v1.0/chats?skip=1')
  })

  test('paginateAll concatenates pages', async () => {
    primeAuth()
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      if (calls === 1) {
        return jsonResponse({
          value: [1, 2],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?p=2',
        })
      }
      return jsonResponse({ value: [3, 4] })
    })
    const all = await paginateAll<number>({ method: 'GET', path: '/x' })
    expect(all).toEqual([1, 2, 3, 4])
  })

  test('respects early break in for-await consumer', async () => {
    primeAuth()
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse({
        value: [calls],
        '@odata.nextLink': `https://graph.microsoft.com/v1.0/x?p=${calls + 1}`,
      })
    })
    let pages = 0
    for await (const _page of paginate<number>({ method: 'GET', path: '/x' })) {
      pages++
      if (pages >= 2) break
    }
    expect(pages).toBe(2)
    expect(calls).toBe(2)
  })

  test('handles empty value array', async () => {
    primeAuth()
    __setTransportForTests(async () => jsonResponse({ value: [] }))
    const all = await paginateAll<unknown>({ method: 'GET', path: '/x' })
    expect(all).toEqual([])
  })
})
