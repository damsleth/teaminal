import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { __resetForTests, __setTransportForTests } from './client'
import {
  CHANNEL_MESSAGE_READ_SCOPE,
  CHANNEL_MESSAGE_SEND_SCOPE,
  listChannelMessages,
  listChannels,
  listJoinedTeams,
  paginateChannelMessages,
  sendChannelMessage,
} from './teams'
import type { Channel, ChannelMessage, Team } from '../types'

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

const TEAM: Team = {
  id: 'team-1',
  displayName: 'Crayon Eng',
  description: 'engineering team',
  isArchived: false,
}

const CHANNEL: Channel = {
  id: '19:abc@thread.tacv2',
  displayName: 'General',
  membershipType: 'standard',
  isArchived: false,
}

const CHANNEL_MESSAGE: ChannelMessage = {
  id: 'cm-1',
  createdDateTime: '2026-04-29T09:00:00Z',
  body: { contentType: 'text', content: 'standup at 10' },
  from: { user: { id: 'u-1', displayName: 'Bjørn' } },
}

describe('listJoinedTeams', () => {
  test('GETs /me/joinedTeams with no query parameters', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [TEAM] })
    })
    const teams = await listJoinedTeams()
    expect(teams).toEqual([TEAM])
    // No "?" - the probe revealed Graph rejects $top/$select here
    expect(seenUrl).toBe('https://graph.microsoft.com/v1.0/me/joinedTeams')
  })

  test('forwards AbortSignal', async () => {
    primeAuth()
    let seenSignal: AbortSignal | undefined
    __setTransportForTests(async (_url, init) => {
      seenSignal = init.signal ?? undefined
      return jsonResponse({ value: [] })
    })
    const ctrl = new AbortController()
    await listJoinedTeams({ signal: ctrl.signal })
    expect(seenSignal).toBe(ctrl.signal)
  })
})

describe('listChannels', () => {
  test('GETs /teams/{id}/channels with the documented $select fields', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [CHANNEL] })
    })
    await listChannels('team-1')
    expect(seenUrl).toContain('/v1.0/teams/team-1/channels?')
    expect(seenUrl).toContain(
      '%24select=id%2CdisplayName%2Cdescription%2CmembershipType%2CisArchived',
    )
  })

  test('URL-encodes team IDs', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [] })
    })
    await listChannels('team:with:colons')
    expect(seenUrl).toContain('/teams/team%3Awith%3Acolons/channels')
  })
})

describe('listChannelMessages', () => {
  test('GETs the channel messages path with $top=50 by default', async () => {
    primeAuth()
    let seenArgs: string[] = []
    setAuthRunner(async (args) => {
      seenArgs = args
      return { stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }
    })
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [CHANNEL_MESSAGE] })
    })
    await listChannelMessages('team-1', '19:abc@thread.tacv2')
    expect(seenUrl).toBe(
      'https://graph.microsoft.com/v1.0/teams/team-1/channels/19%3Aabc%40thread.tacv2/messages?%24top=50',
    )
    expect(seenUrl).not.toContain('%24orderby')
    expect(seenUrl).not.toContain('%24filter')
    expect(seenArgs).toEqual(['token', '--scope', CHANNEL_MESSAGE_READ_SCOPE])
  })

  test('honors a custom $top', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [] })
    })
    await listChannelMessages('team-1', '19:abc', { top: 10 })
    expect(seenUrl).toContain('%24top=10')
  })

  test('reverses descending API order into chronological for the UI', async () => {
    primeAuth()
    const m = (id: string, t: string): ChannelMessage => ({
      id,
      createdDateTime: t,
      body: { contentType: 'text', content: id },
    })
    __setTransportForTests(async () =>
      jsonResponse({
        value: [
          m('latest', '2026-04-29T09:15:00Z'),
          m('middle', '2026-04-29T09:10:00Z'),
          m('oldest', '2026-04-29T09:00:00Z'),
        ],
      }),
    )
    const msgs = await listChannelMessages('team-1', '19:abc')
    expect(msgs.map((x) => x.id)).toEqual(['oldest', 'middle', 'latest'])
  })
})

describe('paginateChannelMessages', () => {
  test('follows @odata.nextLink until exhausted', async () => {
    primeAuth()
    const seenUrls: string[] = []
    __setTransportForTests(async (url) => {
      seenUrls.push(url)
      if (seenUrls.length === 1) {
        return jsonResponse({
          value: [{ ...CHANNEL_MESSAGE, id: 'page1' }],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/teams/team-1/channels/19%3Aabc/messages?%24top=50&%24skiptoken=2',
        })
      }
      return jsonResponse({ value: [{ ...CHANNEL_MESSAGE, id: 'page2' }] })
    })

    const ids: string[] = []
    for await (const page of paginateChannelMessages('team-1', '19:abc')) {
      for (const m of page) ids.push(m.id)
    }
    expect(ids).toEqual(['page1', 'page2'])
    expect(seenUrls).toHaveLength(2)
    expect(seenUrls[1]).toContain('%24skiptoken=2')
  })
})

describe('sendChannelMessage', () => {
  test('POSTs Graph-wrapped {body: {contentType: text, content}}', async () => {
    primeAuth()
    let seenArgs: string[] = []
    setAuthRunner(async (args) => {
      seenArgs = args
      return { stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }
    })
    let seenMethod = ''
    let seenBody = ''
    let seenUrl = ''
    __setTransportForTests(async (url, init) => {
      seenUrl = url
      seenMethod = init.method ?? ''
      seenBody = typeof init.body === 'string' ? init.body : ''
      return jsonResponse({ ...CHANNEL_MESSAGE, id: 'cm-new' })
    })
    const created = await sendChannelMessage('team-1', '19:abc@thread.tacv2', 'hi channel')
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toBe(
      'https://graph.microsoft.com/v1.0/teams/team-1/channels/19%3Aabc%40thread.tacv2/messages',
    )
    expect(JSON.parse(seenBody)).toEqual({
      body: { contentType: 'text', content: 'hi channel' },
    })
    expect(created.id).toBe('cm-new')
    expect(seenArgs).toEqual(['token', '--scope', CHANNEL_MESSAGE_SEND_SCOPE])
  })

  test('forwards AbortSignal', async () => {
    primeAuth()
    let seenSignal: AbortSignal | undefined
    __setTransportForTests(async (_url, init) => {
      seenSignal = init.signal ?? undefined
      return jsonResponse(CHANNEL_MESSAGE)
    })
    const ctrl = new AbortController()
    await sendChannelMessage('team-1', '19:abc', 'hi', { signal: ctrl.signal })
    expect(seenSignal).toBe(ctrl.signal)
  })
})
