import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { __resetForTests, __setTransportForTests, GraphError } from './client'
import { getMyPresence, getPresencesByUserId } from './presence'
import type { Presence } from '../types'

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

function primeAuth(): void {
  setAuthRunner(async () => ({
    stdout: makeJwt({ exp: FAR_FUTURE }),
    stderr: '',
    exitCode: 0,
  }))
}

afterEach(() => {
  __resetForTests()
  resetAuth()
})

describe('getMyPresence', () => {
  test('GETs /me/presence and parses availability + activity', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({
        id: 'me-id',
        availability: 'Available',
        activity: 'Available',
      })
    })
    const presence = await getMyPresence()
    expect(seenUrl).toBe('https://graph.microsoft.com/v1.0/me/presence')
    expect(presence.availability).toBe('Available')
    expect(presence.activity).toBe('Available')
  })

  test('forwards AbortSignal', async () => {
    primeAuth()
    let seenSignal: AbortSignal | undefined
    __setTransportForTests(async (_url, init) => {
      seenSignal = init.signal ?? undefined
      return jsonResponse({ id: 'x', availability: 'Offline', activity: 'Offline' })
    })
    const ctrl = new AbortController()
    await getMyPresence({ signal: ctrl.signal })
    expect(seenSignal).toBe(ctrl.signal)
  })

  test('propagates 403 as GraphError so callers can mark presence unavailable', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse(
        { error: { code: 'Forbidden', message: 'Presence not licensed' } },
        { status: 403 },
      ),
    )
    const err = await getMyPresence().catch((e) => e)
    expect(err).toBeInstanceOf(GraphError)
    expect((err as GraphError).status).toBe(403)
  })
})

describe('getPresencesByUserId', () => {
  test('returns [] without making any HTTP call when input is empty', async () => {
    primeAuth()
    let httpCalls = 0
    __setTransportForTests(async () => {
      httpCalls++
      return jsonResponse({ value: [] })
    })
    const out = await getPresencesByUserId([])
    expect(out).toEqual([])
    expect(httpCalls).toBe(0)
  })

  test('POSTs the documented body shape with all ids in a single batch when <= 650', async () => {
    primeAuth()
    let seenUrl = ''
    let seenMethod = ''
    let seenBody = ''
    let httpCalls = 0
    __setTransportForTests(async (url, init) => {
      httpCalls++
      seenUrl = url
      seenMethod = init.method ?? ''
      seenBody = typeof init.body === 'string' ? init.body : ''
      return jsonResponse({
        value: [
          { id: 'u-1', availability: 'Available', activity: 'Available' },
          { id: 'u-2', availability: 'Busy', activity: 'InACall' },
        ],
      })
    })
    const out = await getPresencesByUserId(['u-1', 'u-2'])
    expect(httpCalls).toBe(1)
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toBe('https://graph.microsoft.com/v1.0/communications/getPresencesByUserId')
    expect(JSON.parse(seenBody)).toEqual({ ids: ['u-1', 'u-2'] })
    expect(out).toHaveLength(2)
    expect(out[0]?.availability).toBe('Available')
  })

  test('chunks at 650 and concatenates across chunks', async () => {
    primeAuth()
    const ids = Array.from({ length: 1301 }, (_, i) => `u-${i}`)
    const seenBatchSizes: number[] = []
    __setTransportForTests(async (_url, init) => {
      const batch = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        ids: string[]
      }
      seenBatchSizes.push(batch.ids.length)
      return jsonResponse({
        value: batch.ids.map<Presence>((id) => ({
          id,
          availability: 'Available',
          activity: 'Available',
        })),
      })
    })
    const out = await getPresencesByUserId(ids)
    expect(seenBatchSizes).toEqual([650, 650, 1])
    expect(out).toHaveLength(1301)
    expect(out[0]?.id).toBe('u-0')
    expect(out[1300]?.id).toBe('u-1300')
  })

  test('chunks at exactly 650 without an empty trailing call', async () => {
    primeAuth()
    const ids = Array.from({ length: 1300 }, (_, i) => `u-${i}`)
    let httpCalls = 0
    __setTransportForTests(async (_url, init) => {
      httpCalls++
      const batch = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        ids: string[]
      }
      return jsonResponse({
        value: batch.ids.map<Presence>((id) => ({
          id,
          availability: 'Available',
          activity: 'Available',
        })),
      })
    })
    await getPresencesByUserId(ids)
    expect(httpCalls).toBe(2)
  })

  test('forwards AbortSignal to every chunk', async () => {
    primeAuth()
    const ids = Array.from({ length: 651 }, (_, i) => `u-${i}`)
    const seenSignals: (AbortSignal | undefined)[] = []
    __setTransportForTests(async (_url, init) => {
      seenSignals.push(init.signal ?? undefined)
      const batch = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        ids: string[]
      }
      return jsonResponse({
        value: batch.ids.map<Presence>((id) => ({
          id,
          availability: 'Available',
          activity: 'Available',
        })),
      })
    })
    const ctrl = new AbortController()
    await getPresencesByUserId(ids, { signal: ctrl.signal })
    expect(seenSignals).toHaveLength(2)
    expect(seenSignals.every((s) => s === ctrl.signal)).toBe(true)
  })

  test('propagates 403 from a chunk so caller can mark other-user presence unavailable', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse(
        { error: { code: 'Forbidden', message: 'Presence.Read.All required' } },
        { status: 403 },
      ),
    )
    const err = await getPresencesByUserId(['u-1', 'u-2']).catch((e) => e)
    expect(err).toBeInstanceOf(GraphError)
    expect((err as GraphError).status).toBe(403)
  })
})
