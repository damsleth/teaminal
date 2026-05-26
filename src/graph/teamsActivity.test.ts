import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests,
  __setTransportForTests,
  classifyActivityType,
  listActivityFeed,
  parseActivityItem,
} from './teamsActivity'
import {
  __resetForTests as resetFederation,
  __setTransportForTests as setFederationTransport,
} from './teamsFederation'
import { __setRegionForTests } from './teamsRegion'

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
  setAuthRunner(async () => ({ stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }))
  setFederationTransport(async () =>
    jsonResponse({ tokens: { skypeToken: 'skype-test-token', expiresIn: 3600 } }),
  )
}

beforeEach(() => {
  __setRegionForTests(undefined, 'emea')
})

afterEach(() => {
  __resetForTests()
  resetFederation()
  resetAuth()
})

describe('classifyActivityType', () => {
  test('canonicalizes a handful of label variants', () => {
    expect(classifyActivityType('mention')).toBe('mention')
    expect(classifyActivityType('AtMention')).toBe('mention')
    expect(classifyActivityType('reply_in_a_thread')).toBe('reply')
    expect(classifyActivityType('REACTION')).toBe('reaction')
    expect(classifyActivityType('FollowedChannelPost')).toBe('follow-post')
    expect(classifyActivityType('missedCall')).toBe('missed-call')
    expect(classifyActivityType('TeamAdded')).toBe('team-added')
  })

  test('returns "unknown" for unrecognized inputs', () => {
    expect(classifyActivityType('NewFutureKind')).toBe('unknown')
    expect(classifyActivityType(undefined)).toBe('unknown')
  })
})

describe('parseActivityItem', () => {
  test('returns null when the row has no id', () => {
    expect(parseActivityItem({})).toBeNull()
    expect(parseActivityItem({ activityType: 'mention' })).toBeNull()
  })

  test('parses a mention row into the canonical ActivityItem shape', () => {
    const item = parseActivityItem({
      id: 'a1',
      activityType: 'mention',
      activityTimestamp: '2026-05-20T10:00:00Z',
      sourceUserImDisplayName: 'Alice',
      sourceUserMri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c',
      conversationLink:
        'https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/19%3Aabc%40thread.tacv2/messages/100',
      messagePreview: '<p>Hi <span>@me</span></p>',
      isRead: false,
    })!
    expect(item.kind).toBe('mention')
    expect(item.senderDisplayName).toBe('Alice')
    expect(item.senderId).toBe('4bc16140-a25f-46fa-af77-572d8b946c1c')
    expect(item.chatId).toBe('19:abc@thread.tacv2')
    expect(item.preview).toBe('Hi @me')
    expect(item.createdAt).toBe('2026-05-20T10:00:00Z')
    expect(item.isRead).toBe(false)
  })

  test('treats numeric / string / alternate-key read flags as read', () => {
    expect(parseActivityItem({ id: 'a', activityType: 'mention', isRead: 1 })!.isRead).toBe(true)
    expect(parseActivityItem({ id: 'b', activityType: 'mention', read: 'true' })!.isRead).toBe(true)
    expect(
      parseActivityItem({ id: 'c', activityType: 'mention', readState: 'read' })!.isRead,
    ).toBe(true)
    expect(parseActivityItem({ id: 'd', activityType: 'mention', seen: true })!.isRead).toBe(true)
  })

  test('defaults isRead to false when no read flag is present', () => {
    expect(parseActivityItem({ id: 'e', activityType: 'mention' })!.isRead).toBe(false)
  })

  test('preserves unknown rawActivityType but classifies to "unknown"', () => {
    const item = parseActivityItem({
      id: 'a2',
      activityType: 'NewKindFromTheFuture',
      activityTimestamp: '2026-05-20T10:00:00Z',
    })!
    expect(item.kind).toBe('unknown')
    expect(item.rawActivityType).toBe('NewKindFromTheFuture')
  })
})

describe('listActivityFeed', () => {
  test('hits the regional CSA endpoint with the csa-audience Bearer', async () => {
    const csaToken = makeJwt({ exp: FAR_FUTURE, aud: 'https://chatsvcagg.teams.microsoft.com' })
    const runnerArgs: string[][] = []
    setAuthRunner(async (args) => {
      runnerArgs.push(args)
      return { stdout: csaToken, stderr: '', exitCode: 0 }
    })
    let seenUrl = ''
    let seenAuth = ''
    let seenSkype = ''
    __setTransportForTests(async (url, init) => {
      seenUrl = url
      const headers = new Headers(init.headers as Record<string, string>)
      seenAuth = headers.get('authorization') ?? ''
      seenSkype = headers.get('x-skypetoken') ?? ''
      return jsonResponse({
        value: [
          {
            id: 'a1',
            activityType: 'mention',
            activityTimestamp: '2026-05-20T10:00:00Z',
            messagePreview: 'hi',
          },
        ],
        _metadata: { syncState: 'cursor-1' },
      })
    })

    const page = await listActivityFeed({ isPrefetch: true })

    expect(seenUrl).toStartWith(
      'https://teams.microsoft.com/api/csa/emea/api/v3/teams/users/me/updates',
    )
    expect(seenUrl).toContain('isPrefetch=true')
    expect(seenAuth).toBe(`Bearer ${csaToken}`)
    expect(seenSkype).toBe('') // CSA uses the Bearer, not the skype token
    expect(runnerArgs.some((a) => a.includes('--audience') && a.includes('csa'))).toBe(true)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.id).toBe('a1')
    expect(page.syncState).toBe('cursor-1')
  })

  test('throws TeamsActivityError on non-2xx with the wire status', async () => {
    primeAuth()
    __setTransportForTests(async () => new Response('boom', { status: 503 }))
    await expect(listActivityFeed()).rejects.toMatchObject({ status: 503 })
  })

  test('returns an empty page for an empty value array (no syncState)', async () => {
    primeAuth()
    __setTransportForTests(async () => jsonResponse({ value: [] }))
    const page = await listActivityFeed()
    expect(page.items).toEqual([])
    expect(page.syncState).toBeUndefined()
  })
})
