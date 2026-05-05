import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests,
  __setTransportForTests,
  getMyTeamsPresence,
  getTeamsPresenceByOid,
  TeamsPresenceError,
  TEAMS_PRESENCE_SCOPE,
} from './teamsPresence'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

const ME_OID = '6555c7ee-7c68-4aa8-9f0c-05164c288c36'

function primeAuth(oid: string = ME_OID): string {
  const token = makeJwt({ exp: FAR_FUTURE, oid })
  setAuthRunner(async (args) => {
    // The Teams presence client must always go through --scope so the
    // FOCI exchange targets presence.teams.microsoft.com (not graph).
    const scopeIdx = args.indexOf('--scope')
    if (scopeIdx < 0 || args[scopeIdx + 1] !== TEAMS_PRESENCE_SCOPE) {
      throw new Error(`expected --scope ${TEAMS_PRESENCE_SCOPE}, got ${args.join(' ')}`)
    }
    return { stdout: token, stderr: '', exitCode: 0 }
  })
  return token
}

afterEach(() => {
  __resetForTests()
  resetAuth()
})

describe('getTeamsPresenceByOid', () => {
  test('returns an empty map without hitting the network when oids is empty', async () => {
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return new Response('', { status: 200 })
    })
    const out = await getTeamsPresenceByOid([])
    expect(out.size).toBe(0)
    expect(calls).toBe(0)
  })

  test('posts the bulk getpresence body and parses the response', async () => {
    primeAuth()
    let seenUrl = ''
    let seenBody = ''
    let seenAuth = ''
    __setTransportForTests(async (url, init) => {
      seenUrl = url
      seenBody = String(init.body ?? '')
      seenAuth = String((init.headers as Record<string, string>)?.Authorization ?? '')
      return new Response(
        JSON.stringify([
          {
            mri: `8:orgid:${ME_OID}`,
            presence: {
              availability: 'Busy',
              activity: 'InACall',
              deviceType: 'Desktop',
              calendarData: { isOutOfOffice: false },
            },
            status: 20000,
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const out = await getTeamsPresenceByOid([ME_OID])
    expect(seenUrl).toBe('https://presence.teams.microsoft.com/v1/presence/getpresence/')
    expect(JSON.parse(seenBody)).toEqual([{ mri: `8:orgid:${ME_OID}` }])
    expect(seenAuth).toMatch(/^Bearer /)
    expect(out.get(ME_OID)).toEqual({
      oid: ME_OID,
      availability: 'Busy',
      activity: 'InACall',
      deviceType: 'Desktop',
      outOfOffice: false,
    })
  })

  test('handles bulk responses and skips entries missing presence', async () => {
    primeAuth()
    const otherOid = '11111111-2222-3333-4444-555555555555'
    __setTransportForTests(async () => {
      return new Response(
        JSON.stringify([
          {
            mri: `8:orgid:${ME_OID}`,
            presence: { availability: 'Available', activity: 'Available' },
            status: 20000,
          },
          {
            mri: `8:orgid:${otherOid}`,
            // No presence object; service returned status 40401 for an
            // unknown user. Must be silently skipped, not throw.
            status: 40401,
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const out = await getTeamsPresenceByOid([ME_OID, otherOid])
    expect(out.size).toBe(1)
    expect(out.get(ME_OID)?.availability).toBe('Available')
    expect(out.has(otherOid)).toBe(false)
  })

  test('throws TeamsPresenceError on 401', async () => {
    primeAuth()
    __setTransportForTests(async () => {
      return new Response('{"substatuscode":{"value":40102}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    })
    let caught: unknown = null
    try {
      await getTeamsPresenceByOid([ME_OID])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TeamsPresenceError)
    expect((caught as TeamsPresenceError).status).toBe(401)
  })

  test('throws TeamsPresenceError on 5xx with body snippet', async () => {
    primeAuth()
    __setTransportForTests(async () => new Response('upstream is sad', { status: 503 }))
    let caught: unknown = null
    try {
      await getTeamsPresenceByOid([ME_OID])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TeamsPresenceError)
    expect((caught as TeamsPresenceError).status).toBe(503)
    expect((caught as TeamsPresenceError).message).toContain('upstream is sad')
  })

  test('throws TeamsPresenceError when response body is not an array', async () => {
    primeAuth()
    __setTransportForTests(async () => {
      return new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    await expect(getTeamsPresenceByOid([ME_OID])).rejects.toBeInstanceOf(TeamsPresenceError)
  })

  test('forwards the abort signal to fetch', async () => {
    primeAuth()
    let seenSignal: AbortSignal | undefined
    __setTransportForTests(async (_url, init) => {
      seenSignal = init.signal as AbortSignal | undefined
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const ctrl = new AbortController()
    await getTeamsPresenceByOid([ME_OID], { signal: ctrl.signal })
    expect(seenSignal).toBe(ctrl.signal)
  })
})

describe('getMyTeamsPresence', () => {
  test('extracts oid from the JWT and returns the matching entry', async () => {
    primeAuth()
    __setTransportForTests(async (_url, init) => {
      // Verify the request used MY oid, not someone else's.
      const body = JSON.parse(String(init.body ?? '[]')) as Array<{ mri: string }>
      expect(body[0]?.mri).toBe(`8:orgid:${ME_OID}`)
      return new Response(
        JSON.stringify([
          {
            mri: `8:orgid:${ME_OID}`,
            presence: {
              availability: 'Available',
              activity: 'Available',
              deviceType: 'Desktop',
            },
            status: 20000,
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const me = await getMyTeamsPresence()
    expect(me?.oid).toBe(ME_OID)
    expect(me?.availability).toBe('Available')
  })

  test('returns null when the JWT carries no oid claim', async () => {
    // FOCI tokens always have oid; this is defensive belt-and-braces.
    const tokenNoOid = makeJwt({ exp: FAR_FUTURE })
    setAuthRunner(async () => ({ stdout: tokenNoOid, stderr: '', exitCode: 0 }))
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return new Response('[]', { status: 200 })
    })
    const out = await getMyTeamsPresence()
    expect(out).toBeNull()
    expect(calls).toBe(0)
  })
})
