import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests,
  __setTransportForTests,
  fetchChats,
  fetchChatsAndTeams,
  fetchTeams,
  mapCsaChat,
  parseChatsPage,
  parseTeamsBootstrap,
} from './teamsCsa'
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

beforeEach(() => {
  __setRegionForTests(undefined, 'emea')
  setAuthRunner(async () => ({ stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }))
})

afterEach(() => {
  __resetForTests()
  resetAuth()
})

// Fixtures mirror the verified live shapes (.tmp probe, since deleted).
const oneOnOne = {
  id: '19:aaaa_bbbb@unq.gbl.spaces',
  isOneOnOne: true,
  threadType: 'chat',
  chatType: 'chat',
  title: null,
  createdAt: '2026-04-01T10:00:00Z',
  members: [
    { mri: '8:orgid:11111111-1111-1111-1111-111111111111', objectId: '11111111-1111-1111-1111-111111111111', displayName: 'Me', role: 'Admin' },
    { mri: '8:orgid:22222222-2222-2222-2222-222222222222', objectId: '22222222-2222-2222-2222-222222222222', displayName: 'Anna Example', email: 'anna@x.com', role: 'Admin' },
  ],
  lastMessage: {
    id: '1779832878074',
    messageType: 'RichText/Html',
    content: '<p>hi</p>',
    originalArrivalTime: '2026-04-02T09:00:00Z',
    from: '8:orgid:22222222-2222-2222-2222-222222222222',
    imDisplayName: 'Anna Example',
  },
}
const groupChat = {
  id: '19:meeting_groupthread@thread.v2',
  isOneOnOne: false,
  threadType: 'chat',
  chatType: 'chat',
  title: 'Project Huddle',
  createdAt: '2026-03-01T10:00:00Z',
  members: [{ mri: '8:orgid:33333333-3333-3333-3333-333333333333', objectId: '33333333-3333-3333-3333-333333333333', displayName: 'Bob' }],
}
const meetingChat = {
  id: '19:meeting_xyz@thread.v2',
  isOneOnOne: false,
  threadType: 'Meeting',
  chatType: 'meeting',
  title: 'Standup',
  createdAt: '2026-03-15T10:00:00Z',
  members: [],
}

describe('mapCsaChat', () => {
  test('maps a 1:1 chat with members + last message preview', () => {
    const c = mapCsaChat(oneOnOne)!
    expect(c.id).toBe('19:aaaa_bbbb@unq.gbl.spaces')
    expect(c.chatType).toBe('oneOnOne')
    expect(c.topic).toBeUndefined()
    expect(c.members).toHaveLength(2)
    expect(c.members?.[1]).toMatchObject({
      displayName: 'Anna Example',
      email: 'anna@x.com',
      userId: '22222222-2222-2222-2222-222222222222',
      roles: ['Admin'],
    })
    expect(c.lastMessagePreview).toMatchObject({
      id: '1779832878074',
      createdDateTime: '2026-04-02T09:00:00Z',
      body: { contentType: 'html', content: '<p>hi</p>' },
    })
    expect(c.lastMessagePreview?.from?.user?.id).toBe('22222222-2222-2222-2222-222222222222')
  })

  test('group chat keeps title as topic and maps chatType group', () => {
    const c = mapCsaChat(groupChat)!
    expect(c.chatType).toBe('group')
    expect(c.topic).toBe('Project Huddle')
  })

  test('meeting chat maps to meeting chatType', () => {
    expect(mapCsaChat(meetingChat)!.chatType).toBe('meeting')
  })

  test('returns null when id is missing', () => {
    expect(mapCsaChat({ isOneOnOne: true })).toBeNull()
  })
})

describe('parseTeamsBootstrap', () => {
  test('maps teams + channels, ignoring the nameless bootstrap chats', () => {
    const { teams, channelsByTeam } = parseTeamsBootstrap({
      teams: [
        {
          id: '19:team1@thread.tacv2',
          displayName: 'ONE Team',
          channels: [
            { id: '19:team1@thread.tacv2', displayName: 'General', description: 'main' },
            { id: '19:chan2@thread.tacv2', displayName: 'Random' },
          ],
        },
      ],
      chats: [{ id: 'x', members: [{ mri: '8:orgid:zz' }] }], // no displayName — ignored here
    })
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({ id: '19:team1@thread.tacv2', displayName: 'ONE Team' })
    expect(channelsByTeam['19:team1@thread.tacv2']).toHaveLength(2)
    expect(channelsByTeam['19:team1@thread.tacv2']?.[0]).toMatchObject({
      displayName: 'General',
      description: 'main',
    })
  })
})

describe('parseChatsPage', () => {
  test('parses items + continuationToken', () => {
    const { chats, continuationToken } = parseChatsPage({
      items: [oneOnOne, groupChat],
      continuationToken: 'next-cursor',
    })
    expect(chats).toHaveLength(2)
    expect(continuationToken).toBe('next-cursor')
  })

  test('no continuationToken when absent', () => {
    expect(parseChatsPage({ items: [] }).continuationToken).toBeUndefined()
  })
})

describe('fetchChats', () => {
  test('GETs the v2 chats endpoint with the csa Bearer and follows pagination', async () => {
    const csaToken = makeJwt({ exp: FAR_FUTURE, aud: 'https://chatsvcagg.teams.microsoft.com' })
    const runnerArgs: string[][] = []
    setAuthRunner(async (args) => {
      runnerArgs.push(args)
      return { stdout: csaToken, stderr: '', exitCode: 0 }
    })
    const urls: string[] = []
    let seenAuth = ''
    let call = 0
    __setTransportForTests(async (url, init) => {
      urls.push(url)
      seenAuth = new Headers(init.headers as Record<string, string>).get('authorization') ?? ''
      call++
      if (call === 1) return jsonResponse({ items: [oneOnOne], continuationToken: 'c2' })
      return jsonResponse({ items: [groupChat] }) // no token → stop
    })

    const chats = await fetchChats()
    expect(chats.map((c) => c.id)).toEqual([oneOnOne.id, groupChat.id])
    expect(urls[0]).toStartWith('https://teams.microsoft.com/api/csa/emea/api/v2/teams/users/me/chats')
    expect(urls[1]).toContain('continuationToken=c2')
    expect(seenAuth).toBe(`Bearer ${csaToken}`)
    expect(runnerArgs.some((a) => a.includes('--audience') && a.includes('csa'))).toBe(true)
  })

  test('throws TeamsCsaError on non-2xx', async () => {
    __setTransportForTests(async () => new Response('nope', { status: 403 }))
    await expect(fetchChats()).rejects.toMatchObject({ status: 403 })
  })
})

describe('fetchTeams', () => {
  test('GETs the v1 bootstrap and returns teams + channels', async () => {
    const urls: string[] = []
    __setTransportForTests(async (url) => {
      urls.push(url)
      return jsonResponse({
        teams: [{ id: '19:t@thread.tacv2', displayName: 'T', channels: [{ id: '19:t@thread.tacv2', displayName: 'General' }] }],
      })
    })
    const { teams, channelsByTeam } = await fetchTeams()
    expect(urls[0]).toBe('https://teams.microsoft.com/api/csa/emea/api/v1/teams/users/me')
    expect(teams).toHaveLength(1)
    expect(channelsByTeam['19:t@thread.tacv2']).toHaveLength(1)
  })
})

describe('fetchChatsAndTeams', () => {
  test('combines chats (v2) + teams (bootstrap)', async () => {
    __setTransportForTests(async (url) => {
      if (url.includes('/api/v2/teams/users/me/chats')) {
        return jsonResponse({ items: [oneOnOne] })
      }
      return jsonResponse({
        teams: [{ id: '19:t@thread.tacv2', displayName: 'T', channels: [] }],
      })
    })
    const out = await fetchChatsAndTeams()
    expect(out.chats).toHaveLength(1)
    expect(out.teams).toHaveLength(1)
    expect(out.channelsByTeam['19:t@thread.tacv2']).toEqual([])
  })

  test('on 401 invalidates the csa token and retries once', async () => {
    let chatsCalls = 0
    __setTransportForTests(async (url) => {
      if (url.includes('/api/v2/teams/users/me/chats')) {
        chatsCalls++
        if (chatsCalls === 1) return new Response('expired', { status: 401 })
        return jsonResponse({ items: [oneOnOne] })
      }
      return jsonResponse({ teams: [] })
    })
    const out = await fetchChatsAndTeams()
    expect(out.chats).toHaveLength(1)
    expect(chatsCalls).toBe(2)
  })
})
