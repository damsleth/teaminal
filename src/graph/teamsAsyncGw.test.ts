import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests,
  __setTransportForTests,
  asyncGwHostForUrl,
  bootstrap,
  fetchObjectById,
  fetchObjectByUrl,
  isAsyncGwUrl,
} from './teamsAsyncGw'
import {
  __resetForTests as resetFederation,
  __setTransportForTests as setFederationTransport,
} from './teamsFederation'
import { __resetForTests as resetRegion, __setRegionForTests } from './teamsRegion'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600
const OID = '4bc16140-a25f-46fa-af77-572d8b946c1c'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function primeAuth(): void {
  setAuthRunner(async () => ({
    stdout: makeJwt({ exp: FAR_FUTURE, oid: OID }),
    stderr: '',
    exitCode: 0,
  }))
}

// Make getSkypeToken resolve deterministically: pin the region and stub the
// authsvc exchange the federation client performs.
function primeSkype(): void {
  __setRegionForTests(undefined, 'emea')
  setFederationTransport(
    async () =>
      new Response(JSON.stringify({ tokens: { skypeToken: 'skype-test', expiresIn: 3600 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

// Stub a federation transport that fails the authsvc exchange, so the
// skype-token path is unavailable and bootstrap falls back to aadtokenauth.
function primeSkypeUnavailable(): void {
  __setRegionForTests(undefined, 'emea')
  setFederationTransport(async () => new Response('no authz', { status: 403 }))
}

afterEach(() => {
  __resetForTests()
  resetAuth()
  resetFederation()
  resetRegion()
})

describe('isAsyncGwUrl', () => {
  test('matches regional asyncgw hosts', () => {
    expect(isAsyncGwUrl('https://eu-prod.asyncgw.teams.microsoft.com/v1/abc')).toBe(true)
    expect(isAsyncGwUrl('https://na-prod.asyncgw.teams.microsoft.com/v1/abc')).toBe(true)
  })

  test('rejects unrelated hosts', () => {
    expect(isAsyncGwUrl('https://media.giphy.com/abc.gif')).toBe(false)
    expect(isAsyncGwUrl('https://graph.microsoft.com/v1.0/me')).toBe(false)
  })
})

describe('asyncGwHostForUrl', () => {
  test('returns the bare host root for a regional URL', () => {
    expect(
      asyncGwHostForUrl('https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/x/views/imgo'),
    ).toBe('https://eu-prod.asyncgw.teams.microsoft.com')
  })

  test('returns null for non-asyncgw URLs', () => {
    expect(asyncGwHostForUrl('https://teams.microsoft.com/x')).toBeNull()
  })
})

describe('bootstrap', () => {
  test('prefers skypetokenauth, stores the cookie pair, and caches the session', async () => {
    primeAuth()
    primeSkype()
    let calls = 0
    let body = ''
    __setTransportForTests(async (url, init) => {
      calls += 1
      expect(url).toContain('/v1/skypetokenauth')
      body = String(init.body ?? '')
      return new Response(null, {
        status: 200,
        headers: { 'set-cookie': 'skypetoken_asm=Bearer%20abc; Path=/; Secure' },
      })
    })
    const a = await bootstrap()
    const b = await bootstrap()
    expect(a.userOid).toBe(OID)
    // Only the name=value pair is kept, not the cookie attributes.
    expect(a.cookie).toBe('skypetoken_asm=Bearer%20abc')
    expect(body).toContain('skypetoken=skype-test')
    // Second call returns the cached session — no extra network.
    expect(calls).toBe(1)
    expect(b).toBe(a)
  })

  test('falls back to aadtokenauth when the skype token is unavailable', async () => {
    primeAuth()
    primeSkypeUnavailable()
    const seen: string[] = []
    __setTransportForTests(async (url, init) => {
      seen.push(url)
      if (url.endsWith('/aadtokenauth')) {
        const headers = new Headers(init.headers as Record<string, string>)
        expect(headers.get('authorization')).toMatch(/^Bearer /)
        return new Response(null, { status: 200, headers: { 'set-cookie': 'AGW=abc; Path=/' } })
      }
      return new Response('unexpected', { status: 500 })
    })
    const a = await bootstrap()
    expect(a.cookie).toBe('AGW=abc')
    expect(seen.some((u) => u.endsWith('/aadtokenauth'))).toBe(true)
  })

  test('throws when both auth paths fail', async () => {
    primeAuth()
    primeSkypeUnavailable()
    __setTransportForTests(async () => new Response('nope', { status: 403 }))
    await expect(bootstrap()).rejects.toMatchObject({ status: 403 })
  })
})

describe('fetchObjectByUrl', () => {
  test('fetches the object using the cached session cookie', async () => {
    primeAuth()
    primeSkype()
    let seenAuth = ''
    let seenCookie = ''
    __setTransportForTests(async (url, init) => {
      if (url.endsWith('/skypetokenauth')) {
        return new Response(null, {
          status: 200,
          headers: { 'set-cookie': 'AGW=session-1' },
        })
      }
      const headers = new Headers(init.headers as Record<string, string>)
      seenCookie = headers.get('cookie') ?? ''
      seenAuth = headers.get('authorization') ?? ''
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    })
    const objectUrl =
      'https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/abc/views/imgpsh_fullsize'
    const out = await fetchObjectByUrl(objectUrl)
    expect(out.contentType).toBe('image/jpeg')
    expect(out.bytes.byteLength).toBe(3)
    expect(seenCookie).toBe('AGW=session-1')
    expect(seenAuth).toBe('')
  })

  test('on 401 refreshes the session and retries once', async () => {
    primeAuth()
    primeSkype()
    let bootstrapCalls = 0
    let objectCalls = 0
    __setTransportForTests(async (url) => {
      if (url.endsWith('/skypetokenauth')) {
        bootstrapCalls += 1
        return new Response(null, {
          status: 200,
          headers: { 'set-cookie': `AGW=session-${bootstrapCalls}` },
        })
      }
      objectCalls += 1
      if (objectCalls === 1) return new Response('expired', { status: 401 })
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    })
    const out = await fetchObjectByUrl(
      'https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/abc/views/original',
    )
    expect(out.bytes.byteLength).toBe(3)
    expect(bootstrapCalls).toBe(2)
    expect(objectCalls).toBe(2)
  })

  test('throws when the URL is not an asyncgw URL', async () => {
    await expect(fetchObjectByUrl('https://media.giphy.com/abc.gif')).rejects.toThrow(
      /not an asyncgw/,
    )
  })
})

describe('fetchObjectById', () => {
  test('builds {host}/v1/{oid}/objects/{id}/views/{view} and fetches the bytes', async () => {
    primeAuth()
    primeSkype()
    let objectUrl = ''
    __setTransportForTests(async (url) => {
      if (url.endsWith('/skypetokenauth')) {
        return new Response(null, { status: 200, headers: { 'set-cookie': 'AGW=s1' } })
      }
      objectUrl = url
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    })
    const out = await fetchObjectById('0-wch-d2-eb96')
    expect(out.bytes.byteLength).toBe(4)
    expect(objectUrl).toBe(
      `https://eu-prod.asyncgw.teams.microsoft.com/v1/${OID}/objects/0-wch-d2-eb96/views/imgpsh_fullsize`,
    )
  })

  test('honors a custom view name', async () => {
    primeAuth()
    primeSkype()
    let objectUrl = ''
    __setTransportForTests(async (url) => {
      if (url.endsWith('/skypetokenauth')) {
        return new Response(null, { status: 200, headers: { 'set-cookie': 'AGW=s1' } })
      }
      objectUrl = url
      return new Response(new Uint8Array([1]), { status: 200 })
    })
    await fetchObjectById('0-wch-d2-eb96', { view: 'imgo' })
    expect(objectUrl).toContain('/views/imgo')
  })
})
