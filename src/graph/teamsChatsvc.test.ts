import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetFederation,
  __setTransportForTests as setFederationTransport,
} from './teamsFederation'
import {
  __resetForTests,
  __setTransportForTests,
  listChannelMessagesViaChatsvc,
  parseFrom,
  parseReactions,
  sendChannelMessageViaChatsvc,
  skypeToChannelMessage,
} from './teamsChatsvc'
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
  setAuthRunner(async () => ({ stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }))
  // The chatsvc messages endpoint authenticates with a Skype token
  // exchanged through Teams authsvc. Tests that don't care about that
  // exchange route the authsvc POST through the federation transport
  // and return a stable token; the chatsvc transport in __setTransport
  // For Tests is what each test actually inspects.
  setFederationTransport(async () =>
    new Response(JSON.stringify({ tokens: { skypeToken: 'skype-test-token', expiresIn: 3600 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

afterEach(() => {
  __resetForTests()
  resetFederation()
  resetAuth()
})

describe('parseFrom', () => {
  test('extracts the orgid AAD UUID from a contacts URL', () => {
    expect(
      parseFrom(
        'https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c',
      ),
    ).toEqual({
      mri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c',
      userId: '4bc16140-a25f-46fa-af77-572d8b946c1c',
    })
  })

  test('passes through a bare MRI', () => {
    expect(parseFrom('8:orgid:abc-uuid')).toEqual({
      mri: '8:orgid:abc-uuid',
      userId: null,
    })
  })

  test('returns nulls for empty input', () => {
    expect(parseFrom(undefined)).toEqual({ mri: null, userId: null })
    expect(parseFrom('')).toEqual({ mri: null, userId: null })
  })
})

describe('skypeToChannelMessage', () => {
  test('maps a regular Skype HTML message to the Graph ChannelMessage shape', () => {
    const out = skypeToChannelMessage({
      id: '1717770000000',
      originalarrivaltime: '2026-04-01T12:00:00Z',
      messagetype: 'RichText/Html',
      from: 'https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c',
      imdisplayname: 'Carl Damsleth',
      content: '<div>hello</div>',
    })
    expect(out.id).toBe('1717770000000')
    expect(out.createdDateTime).toBe('2026-04-01T12:00:00.000Z')
    expect(out.body).toEqual({ contentType: 'html', content: '<div>hello</div>' })
    expect(out.from?.user?.id).toBe('4bc16140-a25f-46fa-af77-572d8b946c1c')
    expect(out.from?.user?.displayName).toBe('Carl Damsleth')
    expect(out.messageType).toBe('message')
  })

  test('marks ThreadActivity rows as systemEventMessage', () => {
    const out = skypeToChannelMessage({
      id: '1',
      originalarrivaltime: '2026-04-01T12:00:00Z',
      messagetype: 'ThreadActivity/MemberJoined',
      content: '<addmember>...</addmember>',
    })
    expect(out.messageType).toBe('systemEventMessage')
  })

  test('translates epoch-ms edittime into lastModifiedDateTime', () => {
    const out = skypeToChannelMessage({
      id: '1',
      originalarrivaltime: '2026-04-01T12:00:00Z',
      messagetype: 'Text',
      content: 'hi',
      properties: { edittime: '1745151600000' },
    })
    expect(out.lastModifiedDateTime).toBe(new Date(1745151600000).toISOString())
  })

  test('preserves replyToId when parentmessageid differs from id', () => {
    const out = skypeToChannelMessage({
      id: '2',
      messagetype: 'Text',
      content: 'reply',
      properties: { parentmessageid: '1' },
    })
    expect(out.replyToId).toBe('1')
  })
})

describe('listChannelMessagesViaChatsvc', () => {
  test('hits the regional chatsvc messages endpoint with the Skype token', async () => {
    primeAuth()
    let seenUrl = ''
    let seenAuth = ''
    __setTransportForTests(async (url, init) => {
      seenUrl = url
      const headers = new Headers(init.headers as Record<string, string>)
      seenAuth = headers.get('authentication') ?? ''
      return jsonResponse({
        messages: [
          {
            id: '1',
            originalarrivaltime: '2026-04-01T12:00:00Z',
            messagetype: 'Text',
            content: 'hi',
          },
        ],
      })
    })

    const page = await listChannelMessagesViaChatsvc('19:abc@thread.tacv2')

    expect(seenUrl).toContain('teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations/')
    expect(seenUrl).toContain(encodeURIComponent('19:abc@thread.tacv2'))
    expect(seenAuth).toBe('skypetoken=skype-test-token')
    expect(page.messages.map((m) => m.id)).toEqual(['1'])
  })

  test('reverses results so messages are oldest-first', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse({
        messages: [
          { id: '3', originalarrivaltime: '2026-04-01T12:00:03Z', messagetype: 'Text' },
          { id: '2', originalarrivaltime: '2026-04-01T12:00:02Z', messagetype: 'Text' },
          { id: '1', originalarrivaltime: '2026-04-01T12:00:01Z', messagetype: 'Text' },
        ],
      }),
    )

    const page = await listChannelMessagesViaChatsvc('19:abc@thread.tacv2')
    expect(page.messages.map((m) => m.id)).toEqual(['1', '2', '3'])
  })

  test('exposes the backward link for older-page navigation', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse({
        messages: [],
        _metadata: {
          backwardLink:
            'https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations/19%3Aabc%40thread.tacv2/messages?startTime=1234&pageSize=20',
        },
      }),
    )
    const page = await listChannelMessagesViaChatsvc('19:abc@thread.tacv2')
    expect(page.backwardLink).toContain('startTime=1234')
  })

  test('filters out replies (parentmessageid != id)', async () => {
    primeAuth()
    __setTransportForTests(async () =>
      jsonResponse({
        messages: [
          { id: '2', messagetype: 'Text', properties: { parentmessageid: '1' } },
          { id: '1', messagetype: 'Text' },
        ],
      }),
    )
    const page = await listChannelMessagesViaChatsvc('19:abc@thread.tacv2')
    expect(page.messages.map((m) => m.id)).toEqual(['1'])
  })
})

describe('parseReactions', () => {
  test('flattens Skype `properties.emotions` into one Reaction per (type, user)', () => {
    const reactions = parseReactions([
      {
        key: 'like',
        users: [
          { mri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c', time: 1745000000000 },
          { mri: '8:orgid:0caa699d-79d5-4660-81d0-ce05b8954fc7', time: 1745000001000 },
        ],
      },
      {
        key: 'heart',
        users: [{ mri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c' }],
      },
    ])
    expect(reactions).toHaveLength(3)
    expect(reactions[0]).toEqual({
      reactionType: 'like',
      createdDateTime: new Date(1745000000000).toISOString(),
      user: { user: { id: '4bc16140-a25f-46fa-af77-572d8b946c1c' } },
    })
    expect(reactions[2]).toEqual({
      reactionType: 'heart',
      user: { user: { id: '4bc16140-a25f-46fa-af77-572d8b946c1c' } },
    })
  })

  test('returns empty list for missing or malformed input', () => {
    expect(parseReactions(undefined)).toEqual([])
    expect(parseReactions([])).toEqual([])
    expect(parseReactions([{ key: undefined, users: [] }])).toEqual([])
  })
})

describe('skypeToChannelMessage with reactions', () => {
  test('attaches reactions parsed from properties.emotions', () => {
    const msg = skypeToChannelMessage({
      id: '1',
      originalarrivaltime: '2026-04-29T09:00:00Z',
      messagetype: 'Text',
      content: 'standup at 10',
      properties: {
        emotions: [
          {
            key: 'like',
            users: [{ mri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c', time: 1745000000000 }],
          },
        ],
      },
    })
    expect(msg.reactions).toEqual([
      {
        reactionType: 'like',
        createdDateTime: new Date(1745000000000).toISOString(),
        user: { user: { id: '4bc16140-a25f-46fa-af77-572d8b946c1c' } },
      },
    ])
  })
})

describe('sendChannelMessageViaChatsvc', () => {
  test('POSTs the Skype-shaped body to the chatsvc messages endpoint', async () => {
    primeAuth()
    const captured: { url?: string; auth?: string; body?: Record<string, unknown> } = {}
    __setTransportForTests(async (url, init) => {
      captured.url = url
      const headers = new Headers(init.headers as Record<string, string>)
      captured.auth = headers.get('authentication') ?? ''
      captured.body = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ OriginalArrivalTime: '2026-04-29T09:01:00Z' }), {
        status: 201,
        headers: {
          'content-type': 'application/json',
          Location:
            'https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/19%3Aabc%40thread.tacv2/messages/9876543210000',
        },
      })
    })

    const sent = await sendChannelMessageViaChatsvc('19:abc@thread.tacv2', 'standup at 10', {
      imdisplayname: 'Carl',
      fromUserId: '4bc16140-a25f-46fa-af77-572d8b946c1c',
    })

    expect(captured.url).toBe(
      'https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations/19%3Aabc%40thread.tacv2/messages',
    )
    expect(captured.auth).toBe('skypetoken=skype-test-token')
    expect(captured.body).toMatchObject({
      content: 'standup at 10',
      messagetype: 'Text',
      contenttype: 'text',
      imdisplayname: 'Carl',
    })
    expect(sent.id).toBe('9876543210000')
    expect(sent.createdDateTime).toBe(new Date('2026-04-29T09:01:00Z').toISOString())
    expect(sent.from?.user?.id).toBe('4bc16140-a25f-46fa-af77-572d8b946c1c')
  })

  test('encodes a reply via properties.parentmessageid and returns replyToId', async () => {
    primeAuth()
    const captured: { body?: Record<string, unknown> } = {}
    __setTransportForTests(async (_url, init) => {
      captured.body = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response('{}', {
        status: 201,
        headers: {
          'content-type': 'application/json',
          Location:
            'https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/19%3Aabc%40thread.tacv2/messages/200',
        },
      })
    })

    const sent = await sendChannelMessageViaChatsvc('19:abc@thread.tacv2', 'reply text', {
      replyToId: '100',
    })

    expect(captured.body?.properties).toEqual({ parentmessageid: '100' })
    expect(sent.replyToId).toBe('100')
    expect(sent.id).toBe('200')
  })
})
