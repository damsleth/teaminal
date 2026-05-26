import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests as resetFederation,
  __setTransportForTests as setFederationTransport,
} from './teamsFederation'
import {
  __resetForTests,
  __setRegionForTests,
  FALLBACK_REGION,
  getCachedEndpoints,
  getCachedRegion,
  ingestAuthzData,
  partitionFromMiddleTier,
  pickRegionFromGtms,
  regionFromHost,
  resolveRegion,
} from './teamsRegion'

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

beforeEach(() => {
  setAuthRunner(async () => ({ stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }))
})

afterEach(() => {
  __resetForTests()
  resetFederation()
  resetAuth()
})

describe('regionFromHost', () => {
  test('extracts the leading short region from a regional host', () => {
    expect(regionFromHost('https://emea.ng.msg.teams.microsoft.com')).toBe('emea')
    expect(regionFromHost('https://amer.ng.msg.teams.microsoft.com/v1/foo')).toBe('amer')
    expect(regionFromHost('https://apac.ng.msg.teams.microsoft.com')).toBe('apac')
  })

  test('rejects non-region prefixes', () => {
    // Bare service host with no region segment.
    expect(regionFromHost('https://teams.microsoft.com')).toBeNull()
    expect(regionFromHost('https://go.trouter.teams.microsoft.com')).toBeNull()
    expect(regionFromHost(undefined)).toBeNull()
    expect(regionFromHost('')).toBeNull()
  })
})

describe('pickRegionFromGtms', () => {
  test('prefers chatService when available', () => {
    expect(
      pickRegionFromGtms({
        chatService: 'https://amer.ng.msg.teams.microsoft.com',
        presenceService: 'https://emea.presence.teams.microsoft.com',
      }),
    ).toBe('amer')
  })

  test('falls through to other service entries', () => {
    expect(
      pickRegionFromGtms({
        chatService: 'https://teams.microsoft.com',
        presenceService: 'https://ind.presence.teams.microsoft.com',
      }),
    ).toBe('ind')
  })

  test('returns null when no entry resolves', () => {
    expect(pickRegionFromGtms({ chatService: 'https://teams.microsoft.com' })).toBeNull()
    expect(pickRegionFromGtms(null)).toBeNull()
    expect(pickRegionFromGtms(undefined)).toBeNull()
  })
})

describe('partitionFromMiddleTier', () => {
  test('extracts the partition path segment from a middleTier URL', () => {
    expect(
      partitionFromMiddleTier('https://teams.microsoft.com/api/mt/part/emea-02'),
    ).toBe('emea-02')
    expect(
      partitionFromMiddleTier('https://teams.microsoft.com/api/mt/part/amer-05/'),
    ).toBe('amer-05')
  })

  test('returns null for non-matching input', () => {
    expect(partitionFromMiddleTier('https://teams.microsoft.com')).toBeNull()
    expect(partitionFromMiddleTier(undefined)).toBeNull()
  })
})

describe('ingestAuthzData', () => {
  test('caches the resolved region per profile', () => {
    ingestAuthzData('demo', {
      regionGtms: { chatService: 'https://amer.ng.msg.teams.microsoft.com' },
    })
    expect(getCachedRegion({ profile: 'demo' })).toBe('amer')
  })

  test('caches region + partition into the endpoints map', () => {
    ingestAuthzData('demo', {
      region: 'emea',
      partition: 'emea02',
      regionGtms: {
        chatService: 'https://emea.ng.msg.teams.microsoft.com',
        middleTier: 'https://teams.microsoft.com/api/mt/part/emea-02',
      },
    })
    expect(getCachedEndpoints({ profile: 'demo' })).toEqual({
      region: 'emea',
      partition: 'emea-02',
    })
  })

  test('falls back to {region}-01 partition when middleTier is absent', () => {
    ingestAuthzData('demo', {
      regionGtms: { chatService: 'https://apac.ng.msg.teams.microsoft.com' },
    })
    expect(getCachedEndpoints({ profile: 'demo' })).toEqual({
      region: 'apac',
      partition: 'apac-01',
    })
  })

  test('ignores payloads without a parseable region', () => {
    ingestAuthzData('demo', { regionGtms: { chatService: 'https://teams.microsoft.com' } })
    expect(getCachedRegion({ profile: 'demo' })).toBeUndefined()
    expect(getCachedEndpoints({ profile: 'demo' })).toBeUndefined()
  })
})

describe('resolveRegion', () => {
  test('returns the cached region without firing authsvc', async () => {
    __setRegionForTests('demo', 'apac')
    setFederationTransport(async () => {
      throw new Error('should not be called')
    })
    await expect(resolveRegion({ profile: 'demo' })).resolves.toBe('apac')
  })

  test('triggers an authsvc round-trip on cold cache and caches the result', async () => {
    let authzCalls = 0
    setFederationTransport(async (url) => {
      if (url.includes('/authsvc/')) {
        authzCalls += 1
        return jsonResponse({
          tokens: { skypeToken: 'skype', expiresIn: 3600 },
          regionGtms: { chatService: 'https://amer.ng.msg.teams.microsoft.com' },
        })
      }
      return jsonResponse({})
    })
    await expect(resolveRegion({ profile: 'cold' })).resolves.toBe('amer')
    expect(authzCalls).toBe(1)
    // Second call hits the cache.
    await expect(resolveRegion({ profile: 'cold' })).resolves.toBe('amer')
    expect(authzCalls).toBe(1)
  })

  test('falls back to FALLBACK_REGION when authsvc fails', async () => {
    setFederationTransport(async () => jsonResponse({ error: 'nope' }, { status: 500 }))
    await expect(resolveRegion({ profile: 'broken' })).resolves.toBe(FALLBACK_REGION)
  })
})
