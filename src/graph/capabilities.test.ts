import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { __resetForTests, __setSleepForTests, __setTransportForTests } from './client'
import {
  __resetForTests as resetTeamsPresence,
  __setTransportForTests as setTeamsPresenceTransport,
} from './teamsPresence'
import { probeCapabilities } from './capabilities'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600
const TEST_OID = '6555c7ee-7c68-4aa8-9f0c-05164c288c36'
const TEAMS_PRESENCE_URL = 'https://presence.teams.microsoft.com/v1/presence/getpresence/'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function teamsPresenceOk(oid: string = TEST_OID): Response {
  return jsonResponse([
    { mri: `8:orgid:${oid}`, presence: { availability: 'Available', activity: 'Available' } },
  ])
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  __resetForTests()
  resetTeamsPresence()
  resetAuth()
})

function primeAuth(): void {
  setAuthRunner(async () => ({
    stdout: makeJwt({ exp: FAR_FUTURE, oid: TEST_OID }),
    stderr: '',
    exitCode: 0,
  }))
}

type StubMap = Record<string, () => Response>

function installTransports(stubs: StubMap, seenUrls?: string[]): void {
  const handler = async (url: string): Promise<Response> => {
    seenUrls?.push(url)
    for (const prefix of Object.keys(stubs)) {
      if (url.startsWith(prefix)) return stubs[prefix]!()
    }
    throw new Error(`unhandled URL in test transport: ${url}`)
  }
  __setTransportForTests(handler)
  setTeamsPresenceTransport(handler)
}

describe('probeCapabilities', () => {
  test('reports ok for every probe when all succeed', async () => {
    primeAuth()
    installTransports({
      'https://graph.microsoft.com/v1.0/me?': () => jsonResponse({ id: 'me-id', displayName: 'X' }),
      'https://graph.microsoft.com/v1.0/chats?': () => jsonResponse({ value: [] }),
      'https://graph.microsoft.com/v1.0/me/joinedTeams': () => jsonResponse({ value: [] }),
      [TEAMS_PRESENCE_URL]: () => teamsPresenceOk(),
    })
    const caps = await probeCapabilities()
    expect(caps.me.ok).toBe(true)
    expect(caps.chats.ok).toBe(true)
    expect(caps.joinedTeams.ok).toBe(true)
    expect(caps.presence.ok).toBe(true)
  })

  test('marks 403 probes as unavailable without bleeding to other probes', async () => {
    primeAuth()
    installTransports({
      'https://graph.microsoft.com/v1.0/me?': () => jsonResponse({ id: 'x', displayName: 'X' }),
      'https://graph.microsoft.com/v1.0/chats?': () => jsonResponse({ value: [] }),
      'https://graph.microsoft.com/v1.0/me/joinedTeams': () =>
        jsonResponse(
          { error: { code: 'Forbidden', message: 'Teams disabled for tenant' } },
          { status: 403 },
        ),
      [TEAMS_PRESENCE_URL]: () => new Response('Presence not licensed', { status: 403 }),
    })
    const caps = await probeCapabilities()
    expect(caps.me.ok).toBe(true)
    expect(caps.chats.ok).toBe(true)
    expect(caps.joinedTeams.ok).toBe(false)
    expect(caps.presence.ok).toBe(false)
    if (!caps.joinedTeams.ok) {
      expect(caps.joinedTeams.reason).toBe('unavailable')
      expect(caps.joinedTeams.status).toBe(403)
      expect(caps.joinedTeams.message).toMatch(/Teams disabled/)
    }
    if (!caps.presence.ok) {
      expect(caps.presence.reason).toBe('unavailable')
      expect(caps.presence.status).toBe(403)
    }
  })

  test('classifies 401 as unauthorized (after the client retry has already failed)', async () => {
    primeAuth()
    const handler = async () =>
      jsonResponse(
        { error: { code: 'InvalidAuthenticationToken', message: 'token expired' } },
        { status: 401 },
      )
    __setTransportForTests(handler)
    setTeamsPresenceTransport(handler)
    const caps = await probeCapabilities()
    expect(caps.me.ok).toBe(false)
    if (!caps.me.ok) {
      expect(caps.me.reason).toBe('unauthorized')
      expect(caps.me.status).toBe(401)
    }
    expect(caps.chats.ok).toBe(false)
    expect(caps.joinedTeams.ok).toBe(false)
    expect(caps.presence.ok).toBe(false)
  })

  test('classifies 429 as transient (after the client retry cap)', async () => {
    primeAuth()
    __setSleepForTests(async () => {})
    installTransports({
      'https://graph.microsoft.com/v1.0/me?': () => jsonResponse({ id: 'x', displayName: 'X' }),
      'https://graph.microsoft.com/v1.0/chats?': () =>
        new Response('throttled', { status: 429, headers: { 'retry-after': '0' } }),
      'https://graph.microsoft.com/v1.0/me/joinedTeams': () => jsonResponse({ value: [] }),
      [TEAMS_PRESENCE_URL]: () => teamsPresenceOk(),
    })
    const caps = await probeCapabilities()
    expect(caps.me.ok).toBe(true)
    expect(caps.chats.ok).toBe(false)
    if (!caps.chats.ok) {
      expect(caps.chats.reason).toBe('transient')
      expect(caps.chats.status).toBe(429)
    }
    expect(caps.joinedTeams.ok).toBe(true)
    expect(caps.presence.ok).toBe(true)
  })

  test('classifies a 5xx as unknown', async () => {
    primeAuth()
    installTransports({
      'https://graph.microsoft.com/v1.0/me?': () => jsonResponse({ id: 'x', displayName: 'X' }),
      'https://graph.microsoft.com/v1.0/chats?': () => jsonResponse({ value: [] }),
      'https://graph.microsoft.com/v1.0/me/joinedTeams': () => jsonResponse({ value: [] }),
      [TEAMS_PRESENCE_URL]: () => new Response('Service Unavailable', { status: 503 }),
    })
    const caps = await probeCapabilities()
    if (!caps.presence.ok) {
      expect(caps.presence.reason).toBe('unknown')
      expect(caps.presence.status).toBe(503)
    } else {
      throw new Error('expected presence to fail')
    }
  })

  test('classifies a network/transport error as unknown without a status', async () => {
    primeAuth()
    const handler = async () => {
      throw new Error('ECONNRESET')
    }
    __setTransportForTests(handler)
    setTeamsPresenceTransport(handler)
    const caps = await probeCapabilities()
    for (const area of ['me', 'chats', 'joinedTeams', 'presence'] as const) {
      const r = caps[area]
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBe('unknown')
        expect(r.status).toBeUndefined()
        expect(r.message).toMatch(/ECONNRESET/)
      }
    }
  })

  test('runs all four probes concurrently', async () => {
    primeAuth()
    let inFlight = 0
    let maxInFlight = 0
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = async (url: string): Promise<Response> => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight--
      if (url.startsWith(TEAMS_PRESENCE_URL)) return teamsPresenceOk()
      if (url.includes('/me/joinedTeams')) return jsonResponse({ value: [] })
      if (url.includes('/chats')) return jsonResponse({ value: [] })
      return jsonResponse({ id: 'x', displayName: 'X' })
    }
    __setTransportForTests(handler)
    setTeamsPresenceTransport(handler)
    const pending = probeCapabilities()
    // Yield to let all four probes reach the transport await
    await Bun.sleep(20)
    expect(maxInFlight).toBe(4)
    release!()
    const caps = await pending
    expect(caps.me.ok).toBe(true)
    expect(caps.chats.ok).toBe(true)
    expect(caps.joinedTeams.ok).toBe(true)
    expect(caps.presence.ok).toBe(true)
  })

  test('records the right URLs for each probe', async () => {
    primeAuth()
    const seen: string[] = []
    installTransports(
      {
        'https://graph.microsoft.com/v1.0/me?': () => jsonResponse({ id: 'x', displayName: 'X' }),
        'https://graph.microsoft.com/v1.0/chats?': () => jsonResponse({ value: [] }),
        'https://graph.microsoft.com/v1.0/me/joinedTeams': () => jsonResponse({ value: [] }),
        [TEAMS_PRESENCE_URL]: () => teamsPresenceOk(),
      },
      seen,
    )
    await probeCapabilities()
    const meUrl = seen.find((u) => u.startsWith('https://graph.microsoft.com/v1.0/me?'))
    const chatsUrl = seen.find((u) => u.startsWith('https://graph.microsoft.com/v1.0/chats?'))
    const teamsUrl = seen.find((u) => u === 'https://graph.microsoft.com/v1.0/me/joinedTeams')
    const presenceUrl = seen.find((u) => u === TEAMS_PRESENCE_URL)
    expect(meUrl).toContain('%24select=id%2CdisplayName')
    expect(chatsUrl).toContain('%24top=1')
    expect(chatsUrl).toContain('%24expand=lastMessagePreview')
    // /me/joinedTeams rejects $top under delegated auth, so the probe goes
    // unparameterized.
    expect(teamsUrl).toBe('https://graph.microsoft.com/v1.0/me/joinedTeams')
    // Presence probe targets the Teams unified presence endpoint, not
    // Graph /me/presence (which 403s in tenants without Presence.Read).
    expect(presenceUrl).toBe(TEAMS_PRESENCE_URL)
  })
})
