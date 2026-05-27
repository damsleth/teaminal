import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { __resetForTests, __setTransportForTests, setAudiencePreference } from './client'
import { getMe } from './me'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  __resetForTests()
  resetAuth()
})

describe('getMe', () => {
  test('hits /me with $select for the four required fields', async () => {
    setAuthRunner(async () => ({
      stdout: makeJwt({ exp: FAR_FUTURE }),
      stderr: '',
      exitCode: 0,
    }))
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({
        id: '00000000-0000-0000-0000-000000000001',
        displayName: 'Kari Anne Nordmann',
        userPrincipalName: 'kim@example.onmicrosoft.com',
        mail: 'kim@example.com',
      })
    })

    const me = await getMe()
    expect(me.id).toBe('00000000-0000-0000-0000-000000000001')
    expect(me.displayName).toBe('Kari Anne Nordmann')
    expect(me.userPrincipalName).toBe('kim@example.onmicrosoft.com')
    expect(me.mail).toBe('kim@example.com')
    expect(seenUrl).toBe(
      'https://graph.microsoft.com/v1.0/me?%24select=id%2CdisplayName%2CuserPrincipalName%2Cmail',
    )
  })

  test('preserves null mail (users without a mailbox)', async () => {
    setAuthRunner(async () => ({
      stdout: makeJwt({ exp: FAR_FUTURE }),
      stderr: '',
      exitCode: 0,
    }))
    __setTransportForTests(async () =>
      jsonResponse({
        id: 'guest',
        displayName: 'Guest',
        userPrincipalName: 'guest#EXT#@tenant.onmicrosoft.com',
        mail: null,
      }),
    )
    const me = await getMe()
    expect(me.mail).toBeNull()
  })

  test('forwards AbortSignal', async () => {
    setAuthRunner(async () => ({
      stdout: makeJwt({ exp: FAR_FUTURE }),
      stderr: '',
      exitCode: 0,
    }))
    let seenSignal: AbortSignal | undefined
    __setTransportForTests(async (_url, init) => {
      seenSignal = init.signal ?? undefined
      return jsonResponse({ id: 'x', displayName: 'X', userPrincipalName: 'x@x', mail: null })
    })
    const ctrl = new AbortController()
    await getMe(ctrl.signal)
    expect(seenSignal).toBe(ctrl.signal)
  })

  test('falls back to token claims when graph /me 401s (Conditional Access)', async () => {
    setAuthRunner(async () => ({
      stdout: makeJwt({
        exp: FAR_FUTURE,
        oid: '11111111-1111-1111-1111-111111111111',
        name: 'Nordmann, Kari Anne',
        upn: 'kari.nordmann@contoso.com',
        email: 'kari@contoso.com',
      }),
      stderr: '',
      exitCode: 0,
    }))
    __setTransportForTests(async () =>
      jsonResponse({ error: { code: 'Unauthorized', message: 'CA' } }, { status: 401 }),
    )
    const me = await getMe()
    expect(me.id).toBe('11111111-1111-1111-1111-111111111111')
    expect(me.displayName).toBe('Nordmann, Kari Anne')
    expect(me.userPrincipalName).toBe('kari.nordmann@contoso.com')
    expect(me.mail).toBe('kari@contoso.com')
  })

  test('ic3 audience derives identity from token claims without calling graph /me', async () => {
    setAudiencePreference('ic3', { fallback: false })
    setAuthRunner(async () => ({
      stdout: makeJwt({
        exp: FAR_FUTURE,
        oid: '11111111-1111-1111-1111-111111111111',
        name: 'Nordmann, Kari Anne',
        upn: 'kari.nordmann@contoso.com',
      }),
      stderr: '',
      exitCode: 0,
    }))
    let graphCalled = false
    __setTransportForTests(async () => {
      graphCalled = true
      return jsonResponse({ error: { code: 'Unauthorized', message: 'CA' } }, { status: 401 })
    })
    const me = await getMe()
    expect(me.id).toBe('11111111-1111-1111-1111-111111111111')
    expect(me.displayName).toBe('Nordmann, Kari Anne')
    expect(graphCalled).toBe(false)
  })

  test('rethrows the 401 when the token has no oid to fall back on', async () => {
    setAuthRunner(async () => ({
      stdout: makeJwt({ exp: FAR_FUTURE }), // no oid
      stderr: '',
      exitCode: 0,
    }))
    __setTransportForTests(async () =>
      jsonResponse({ error: { code: 'Unauthorized', message: 'CA' } }, { status: 401 }),
    )
    await expect(getMe()).rejects.toMatchObject({ status: 401 })
  })
})
