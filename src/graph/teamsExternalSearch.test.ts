import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetFederation,
  __setTransportForTests as setFederationTransport,
} from './teamsFederation'
import {
  __resetForTests,
  __setTransportForTests,
  searchExternalUsers,
  skypeRowToDirectoryUser,
  userIdFromMri,
} from './teamsExternalSearch'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'

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

function primeAuth(): void {
  // searchExternalUsers uses owa-piggy directly with the spaces scope
  // (Authorization: Bearer); the federation transport is unused here
  // but reset between tests for hygiene.
  setAuthRunner(async () => ({ stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }))
  setFederationTransport(async () =>
    jsonResponse({ tokens: { skypeToken: 'skype-test-token', expiresIn: 3600 } }),
  )
}

afterEach(() => {
  __resetForTests()
  resetFederation()
  resetAuth()
})

describe('userIdFromMri', () => {
  test('extracts the canonical AAD UUID from an orgid MRI', () => {
    expect(userIdFromMri('8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c')).toBe(
      '4bc16140-a25f-46fa-af77-572d8b946c1c',
    )
  })

  test('lowercases the UUID', () => {
    expect(userIdFromMri('8:orgid:4BC16140-A25F-46FA-AF77-572D8B946C1C')).toBe(
      '4bc16140-a25f-46fa-af77-572d8b946c1c',
    )
  })

  test('passes consumer-account MRIs through verbatim', () => {
    expect(userIdFromMri('8:live:cid-123abc')).toBe('8:live:cid-123abc')
  })

  test('returns null for missing input', () => {
    expect(userIdFromMri(undefined)).toBeNull()
    expect(userIdFromMri('')).toBeNull()
  })
})

describe('skypeRowToDirectoryUser', () => {
  test('maps a typical Skype row to the DirectoryUser shape', () => {
    const out = skypeRowToDirectoryUser({
      mri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c',
      displayName: 'Damsleth, Carl Joakim',
      email: 'kim@damsleth.no',
      userPrincipalName: 'kim@damsleth.no',
    })
    expect(out).toEqual({
      id: '4bc16140-a25f-46fa-af77-572d8b946c1c',
      displayName: 'Damsleth, Carl Joakim',
      userPrincipalName: 'kim@damsleth.no',
      mail: 'kim@damsleth.no',
    })
  })

  test('returns null when the row has no MRI', () => {
    expect(skypeRowToDirectoryUser({ displayName: 'No MRI' })).toBeNull()
  })

  test('falls back to upn when userPrincipalName is missing', () => {
    const out = skypeRowToDirectoryUser({
      mri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c',
      upn: 'kim@damsleth.no',
    })
    expect(out?.userPrincipalName).toBe('kim@damsleth.no')
  })
})

describe('searchExternalUsers', () => {
  test('POSTs the email body to /api/mt/part/{region}/beta/users/searchV2 with the spaces token', async () => {
    primeAuth()
    let seenUrl = ''
    let seenAuth = ''
    let seenMethod = ''
    let seenBody = ''
    __setTransportForTests(async (url, init) => {
      seenUrl = url
      seenMethod = init.method ?? ''
      seenBody = typeof init.body === 'string' ? init.body : ''
      const headers = new Headers(init.headers as Record<string, string>)
      seenAuth = headers.get('authorization') ?? ''
      return jsonResponse({
        type: 'Microsoft.Teams.MiddleTier.Search.Contracts.Search.SearchResults',
        value: [
          {
            mri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c',
            objectId: '4bc16140-a25f-46fa-af77-572d8b946c1c',
            displayName: 'Damsleth, Carl Joakim',
            email: 'kim@damsleth.no',
            userPrincipalName: 'kim@damsleth.no',
          },
        ],
      })
    })

    const users = await searchExternalUsers('kim@damsleth.no')
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toContain('https://teams.microsoft.com/api/mt/part/emea/beta/users/searchV2')
    expect(seenUrl).toContain('source=newChat')
    expect(seenUrl).toContain('skypeTeamsInfo=true')
    expect(seenAuth).toMatch(/^Bearer /)
    // Body is the bare email as a JSON string (HAR-confirmed shape).
    expect(JSON.parse(seenBody)).toBe('kim@damsleth.no')
    expect(users).toHaveLength(1)
    expect(users[0]?.id).toBe('4bc16140-a25f-46fa-af77-572d8b946c1c')
    expect(users[0]?.mail).toBe('kim@damsleth.no')
  })

  test('handles bare-array response shape', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse([
        { mri: '8:orgid:abc-1234', displayName: 'A' },
        { mri: '8:orgid:def-5678', displayName: 'B' },
      ]),
    )
    const users = await searchExternalUsers('a@b.com')
    expect(users.map((u) => u.displayName)).toEqual(['A', 'B'])
  })

  test('caches results within the TTL window', async () => {
    primeAuth()
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse([
        { mri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c', email: 'k@d.no' },
      ])
    })
    await searchExternalUsers('k@d.no')
    await searchExternalUsers('k@d.no')
    await searchExternalUsers('K@D.NO') // case-insensitive cache key
    expect(calls).toBe(1)
  })

  test('returns empty list on 404', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse({ message: 'not found' }, { status: 404 }),
    )
    await expect(searchExternalUsers('nobody@nope.example')).resolves.toEqual([])
  })

  test('throws TeamsExternalSearchError on 500', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse({ message: 'boom' }, { status: 500 }),
    )
    await expect(searchExternalUsers('boom@example.com')).rejects.toThrow(/searchV2 500/)
  })

  test('returns [] for empty query without hitting the network', async () => {
    primeAuth()
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse([])
    })
    expect(await searchExternalUsers('')).toEqual([])
    expect(await searchExternalUsers('   ')).toEqual([])
    expect(calls).toBe(0)
  })

  test('honors top to cap result count', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse(
        Array.from({ length: 10 }, (_, i) => ({
          mri: `8:orgid:11111111-1111-1111-1111-${String(i).padStart(12, '0')}`,
          displayName: `User ${i}`,
        })),
      ),
    )
    const users = await searchExternalUsers('many@example.com', { top: 3 })
    expect(users).toHaveLength(3)
  })
})
