import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { __resetForTests, __setTransportForTests } from './client'
import { getChatsBatch } from './chats'

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
  setAuthRunner(async () => ({ stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }))
}

afterEach(() => {
  __resetForTests()
  resetAuth()
})

describe('getChatsBatch', () => {
  test('POSTs /$batch with one sub-request per chat', async () => {
    primeAuth()
    let seenUrl = ''
    let seenBody = ''
    __setTransportForTests(async (url, init) => {
      seenUrl = url
      seenBody = typeof init.body === 'string' ? init.body : ''
      return jsonResponse({
        responses: [
          {
            id: '0',
            status: 200,
            body: { id: 'c1', chatType: 'oneOnOne', members: [{ id: 'm1', userId: 'u1' }] },
          },
          {
            id: '1',
            status: 200,
            body: { id: 'c2', chatType: 'oneOnOne', members: [{ id: 'm2', userId: 'u2' }] },
          },
        ],
      })
    })

    const result = await getChatsBatch(['c1', 'c2'], { members: true })
    expect(seenUrl).toBe('https://graph.microsoft.com/v1.0/$batch')
    const parsed = JSON.parse(seenBody) as {
      requests: { id: string; method: string; url: string }[]
    }
    expect(parsed.requests).toHaveLength(2)
    expect(parsed.requests[0]?.url).toBe('/chats/c1?$expand=members')
    expect(parsed.requests[1]?.url).toBe('/chats/c2?$expand=members')
    expect(result.hydrated.size).toBe(2)
    expect(result.errors.size).toBe(0)
    expect(result.hydrated.get('c1')?.members?.length).toBe(1)
  })

  test('splits >20 chats into multiple batches', async () => {
    primeAuth()
    const chatIds = Array.from({ length: 45 }, (_, i) => `c${i}`)
    let batchCount = 0
    __setTransportForTests(async (_url, init) => {
      batchCount++
      const body = JSON.parse(String(init.body)) as { requests: { id: string }[] }
      return jsonResponse({
        responses: body.requests.map((r) => ({
          id: r.id,
          status: 200,
          body: { id: `c${r.id}`, chatType: 'oneOnOne' },
        })),
      })
    })
    await getChatsBatch(chatIds)
    // 45 chats / 20 per batch = 3 batches.
    expect(batchCount).toBe(3)
  })

  test('routes per-sub-request errors into the errors map without throwing', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse({
        responses: [
          { id: '0', status: 200, body: { id: 'c1', chatType: 'oneOnOne' } },
          { id: '1', status: 403, body: { error: { message: 'forbidden' } } },
          { id: '2', status: 404, body: { error: { message: 'not found' } } },
        ],
      }),
    )
    const result = await getChatsBatch(['c1', 'c2', 'c3'])
    expect(result.hydrated.size).toBe(1)
    expect(result.errors.size).toBe(2)
    expect(result.errors.get('c2')).toEqual({ status: 403, message: 'forbidden' })
    expect(result.errors.get('c3')?.status).toBe(404)
  })

  test('returns immediately on empty input', async () => {
    primeAuth()
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse({ responses: [] })
    })
    const result = await getChatsBatch([])
    expect(calls).toBe(0)
    expect(result.hydrated.size).toBe(0)
  })

  test('omits $expand=members when not requested', async () => {
    primeAuth()
    let seenBody = ''
    __setTransportForTests(async (_url, init) => {
      seenBody = typeof init.body === 'string' ? init.body : ''
      return jsonResponse({
        responses: [{ id: '0', status: 200, body: { id: 'c1', chatType: 'oneOnOne' } }],
      })
    })
    await getChatsBatch(['c1'])
    const parsed = JSON.parse(seenBody) as { requests: { url: string }[] }
    expect(parsed.requests[0]?.url).toBe('/chats/c1')
  })
})
