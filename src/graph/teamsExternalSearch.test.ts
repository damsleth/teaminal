import { accountRef } from '../account'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
import { __setRegionForTests } from './teamsRegion'
import { setActiveProfile } from './client'

const ACCOUNT = accountRef(undefined)

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

beforeEach(() => {
  __setRegionForTests(undefined, 'emea')
  // Every test in this file goes through searchExternalUsers, which mints a
  // token before it does anything else. Priming here rather than per-test is
  // what stops a new test from silently spawning the real owa-piggy binary -
  // which passes on a dev box that has it installed and fails on CI.
  primeAuth()
})

afterEach(() => {
  __resetForTests()
  resetFederation()
  resetAuth()
})

describe('userIdFromMri', () => {
  test('extracts the canonical AAD UUID from an orgid MRI', () => {
    expect(userIdFromMri('8:orgid:22222222-2222-2222-2222-222222222222')).toBe(
      '22222222-2222-2222-2222-222222222222',
    )
  })

  test('lowercases the UUID', () => {
    expect(userIdFromMri('8:orgid:22222222-2222-2222-2222-222222222222')).toBe(
      '22222222-2222-2222-2222-222222222222',
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
      mri: '8:orgid:22222222-2222-2222-2222-222222222222',
      displayName: 'Nordmann, Kari Anne',
      email: 'alice@example.com',
      userPrincipalName: 'alice@example.com',
    })
    expect(out).toEqual({
      id: '22222222-2222-2222-2222-222222222222',
      displayName: 'Nordmann, Kari Anne',
      userPrincipalName: 'alice@example.com',
      mail: 'alice@example.com',
    })
  })

  test('returns null when the row has no MRI', () => {
    expect(skypeRowToDirectoryUser({ displayName: 'No MRI' })).toBeNull()
  })

  test('falls back to upn when userPrincipalName is missing', () => {
    const out = skypeRowToDirectoryUser({
      mri: '8:orgid:22222222-2222-2222-2222-222222222222',
      upn: 'alice@example.com',
    })
    expect(out?.userPrincipalName).toBe('alice@example.com')
  })
})

describe('searchExternalUsers', () => {
  test('POSTs the email body to /api/mt/part/{region}/beta/users/searchV2 with the spaces token', async () => {
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
            mri: '8:orgid:22222222-2222-2222-2222-222222222222',
            objectId: '22222222-2222-2222-2222-222222222222',
            displayName: 'Nordmann, Kari Anne',
            email: 'alice@example.com',
            userPrincipalName: 'alice@example.com',
          },
        ],
      })
    })

    const users = await searchExternalUsers('alice@example.com', { account: ACCOUNT })
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toContain('https://teams.microsoft.com/api/mt/part/emea/beta/users/searchV2')
    expect(seenUrl).toContain('source=newChat')
    expect(seenUrl).toContain('skypeTeamsInfo=true')
    expect(seenAuth).toMatch(/^Bearer /)
    // Body is the bare email as a JSON string (HAR-confirmed shape).
    expect(JSON.parse(seenBody)).toBe('alice@example.com')
    expect(users).toHaveLength(1)
    expect(users[0]?.id).toBe('22222222-2222-2222-2222-222222222222')
    expect(users[0]?.mail).toBe('alice@example.com')
  })

  test('handles bare-array response shape', async () => {
    __setTransportForTests(async () =>
      jsonResponse([
        { mri: '8:orgid:abc-1234', displayName: 'A' },
        { mri: '8:orgid:def-5678', displayName: 'B' },
      ]),
    )
    const users = await searchExternalUsers('a@b.com', { account: ACCOUNT })
    expect(users.map((u) => u.displayName)).toEqual(['A', 'B'])
  })

  test('caches results within the TTL window', async () => {
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse([
        { mri: '8:orgid:22222222-2222-2222-2222-222222222222', email: 'k@example.com' },
      ])
    })
    await searchExternalUsers('k@example.com', { account: ACCOUNT })
    await searchExternalUsers('k@example.com', { account: ACCOUNT })
    await searchExternalUsers('K@EXAMPLE.COM', { account: ACCOUNT }) // case-insensitive cache key
    expect(calls).toBe(1)
  })

  test("does not serve one profile's cached hits to another profile", async () => {
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse([
        { mri: '8:orgid:22222222-2222-2222-2222-222222222222', email: 'k@example.com' },
      ])
    })
    await searchExternalUsers('k@example.com', { account: accountRef('a'), region: 'emea' })
    await searchExternalUsers('k@example.com', { account: accountRef('b'), region: 'emea' })
    expect(calls).toBe(2)
  })

  test('the active account changing mid-search does not move the token off its account', async () => {
    __setRegionForTests('a', 'emea')
    __setRegionForTests('b', 'emea')
    const profiles: (string | undefined)[] = []
    setAuthRunner(async (args) => {
      const i = args.indexOf('--profile')
      profiles.push(i >= 0 ? args[i + 1] : undefined)
      return { stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }
    })
    __setTransportForTests(async () => jsonResponse([]))
    setActiveProfile('a')
    try {
      const pending = searchExternalUsers('k@example.com', { account: accountRef('a') })
      setActiveProfile('b') // switch lands while the search awaits its region
      await pending
    } finally {
      setActiveProfile(undefined)
    }
    expect(profiles[0]).toBe('a')
  })

  test('returns empty list on 404', async () => {
    __setTransportForTests(async () => jsonResponse({ message: 'not found' }, { status: 404 }))
    await expect(searchExternalUsers('nobody@nope.example', { account: ACCOUNT })).resolves.toEqual(
      [],
    )
  })

  test('throws TeamsExternalSearchError on 500', async () => {
    __setTransportForTests(async () => jsonResponse({ message: 'boom' }, { status: 500 }))
    await expect(searchExternalUsers('boom@example.com', { account: ACCOUNT })).rejects.toThrow(
      /searchV2 500/,
    )
  })

  test('returns [] for empty query without hitting the network', async () => {
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse([])
    })
    expect(await searchExternalUsers('', { account: ACCOUNT })).toEqual([])
    expect(await searchExternalUsers('   ', { account: ACCOUNT })).toEqual([])
    expect(calls).toBe(0)
  })

  test('honors top to cap result count', async () => {
    __setTransportForTests(async () =>
      jsonResponse(
        Array.from({ length: 10 }, (_, i) => ({
          mri: `8:orgid:11111111-1111-1111-1111-${String(i).padStart(12, '0')}`,
          displayName: `User ${i}`,
        })),
      ),
    )
    const users = await searchExternalUsers('many@example.com', { account: ACCOUNT, top: 3 })
    expect(users).toHaveLength(3)
  })
})

describe('federated fallback', () => {
  test('falls through to externalsearchv3 when searchV2 finds nothing for an email', async () => {
    const seen: string[] = []
    __setTransportForTests(async (url) => {
      seen.push(url)
      if (url.includes('searchV2'))
        return new Response(JSON.stringify({ value: [] }), { status: 200 })
      return new Response(
        JSON.stringify([
          {
            mri: '8:orgid:44444444-4444-4444-4444-444444444444',
            displayName: 'Kari Anne Nordmann',
            email: 'kari@example.com',
            userPrincipalName: 'kari@example.com',
            type: 'Federated',
          },
        ]),
        { status: 200 },
      )
    })
    const users = await searchExternalUsers('kari@example.com', { account: ACCOUNT })
    expect(seen[1]).toContain('/beta/users/kari%40example.com/externalsearchv3')
    expect(users).toEqual([
      {
        id: '44444444-4444-4444-4444-444444444444',
        displayName: 'Kari Anne Nordmann',
        userPrincipalName: 'kari@example.com',
        mail: 'kari@example.com',
      },
    ])
  })

  test('skips the federated call for non-email terms, and swallows its 400', async () => {
    const seen: string[] = []
    __setTransportForTests(async (url) => {
      seen.push(url)
      if (url.includes('searchV2'))
        return new Response(JSON.stringify({ value: [] }), { status: 200 })
      return new Response('{"errorCode":"BadRequest"}', { status: 400 })
    })
    expect(await searchExternalUsers('Ola Nordmann', { account: ACCOUNT })).toEqual([])
    expect(seen).toHaveLength(1)
    __resetForTests()
    seen.length = 0
    __setTransportForTests(async (url) => {
      seen.push(url)
      return url.includes('searchV2')
        ? new Response(JSON.stringify({ value: [] }), { status: 200 })
        : new Response('{"errorCode":"BadRequest"}', { status: 400 })
    })
    expect(await searchExternalUsers('ghost@nowhere.example', { account: ACCOUNT })).toEqual([])
    expect(seen[1]).toContain('/externalsearchv3')
  })
})
