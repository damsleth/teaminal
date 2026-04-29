import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { __resetForTests, __setTransportForTests } from './client'
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
        displayName: 'Carl Joakim Damsleth',
        userPrincipalName: 'kim@example.onmicrosoft.com',
        mail: 'kim@example.com',
      })
    })

    const me = await getMe()
    expect(me.id).toBe('00000000-0000-0000-0000-000000000001')
    expect(me.displayName).toBe('Carl Joakim Damsleth')
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
})
