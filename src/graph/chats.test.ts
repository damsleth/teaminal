import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { __resetForTests, __setTransportForTests } from './client'
import { getChat, listChats, listMessages, sendMessage } from './chats'
import type { Chat, ChatMessage } from '../types'

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

const SAMPLE_CHAT: Chat = {
  id: '19:abc@unq.gbl.spaces',
  topic: 'Standup',
  createdDateTime: '2026-04-29T08:00:00Z',
  chatType: 'group',
  lastMessagePreview: {
    id: 'm-1',
    createdDateTime: '2026-04-29T09:15:00Z',
    body: { contentType: 'text', content: 'ack' },
    from: { user: { id: 'u-1', displayName: 'Bjørn' } },
  },
}

const SAMPLE_MESSAGE: ChatMessage = {
  id: 'm-1',
  createdDateTime: '2026-04-29T09:15:00Z',
  body: { contentType: 'text', content: 'ack' },
  from: { user: { id: 'u-1', displayName: 'Bjørn' } },
}

describe('listChats', () => {
  test('issues GET /chats with $expand, $top default, and the correct $orderby', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [SAMPLE_CHAT] })
    })
    const chats = await listChats()
    expect(chats).toHaveLength(1)
    expect(seenUrl).toContain('/v1.0/chats?')
    expect(seenUrl).toContain('%24expand=lastMessagePreview')
    expect(seenUrl).toContain('%24top=50')
    expect(seenUrl).toContain('%24orderby=lastMessagePreview%2FcreatedDateTime+desc')
  })

  test('honors a custom top', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [] })
    })
    await listChats({ top: 10 })
    expect(seenUrl).toContain('%24top=10')
  })

  test('forwards AbortSignal', async () => {
    primeAuth()
    let seenSignal: AbortSignal | undefined
    __setTransportForTests(async (_url, init) => {
      seenSignal = init.signal ?? undefined
      return jsonResponse({ value: [] })
    })
    const ctrl = new AbortController()
    await listChats({ signal: ctrl.signal })
    expect(seenSignal).toBe(ctrl.signal)
  })
})

describe('getChat', () => {
  test('omits $expand when members is not requested', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse(SAMPLE_CHAT)
    })
    await getChat('19:abc@unq.gbl.spaces')
    // No query string at all
    expect(seenUrl).toBe(
      'https://graph.microsoft.com/v1.0/chats/19%3Aabc%40unq.gbl.spaces',
    )
  })

  test('adds $expand=members when requested', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ ...SAMPLE_CHAT, members: [] })
    })
    await getChat('19:abc@unq.gbl.spaces', { members: true })
    expect(seenUrl).toContain('%24expand=members')
  })

  test('URL-encodes chat IDs containing : and @', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse(SAMPLE_CHAT)
    })
    await getChat('19:meeting_xxx@thread.v2')
    expect(seenUrl).toContain('19%3Ameeting_xxx%40thread.v2')
  })
})

describe('listMessages', () => {
  test('uses $top=50 and descending $orderby on the initial call', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [SAMPLE_MESSAGE] })
    })
    await listMessages('19:abc@unq.gbl.spaces')
    expect(seenUrl).toContain('/messages?')
    expect(seenUrl).toContain('%24top=50')
    expect(seenUrl).toContain('%24orderby=createdDateTime+desc')
    expect(seenUrl).not.toContain('%24filter=')
  })

  test('adds $filter=createdDateTime lt {iso} when paging older', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [] })
    })
    await listMessages('19:abc@unq.gbl.spaces', {
      beforeCreatedDateTime: '2026-04-29T09:00:00Z',
    })
    expect(seenUrl).toContain('%24filter=createdDateTime+lt+2026-04-29T09%3A00%3A00Z')
    // $orderby is still required to match $filter property
    expect(seenUrl).toContain('%24orderby=createdDateTime+desc')
  })

  test('honors a custom top', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ value: [] })
    })
    await listMessages('19:abc@unq.gbl.spaces', { top: 10 })
    expect(seenUrl).toContain('%24top=10')
  })

  test('reverses the descending API result into chronological order for rendering', async () => {
    primeAuth()
    const m = (id: string, t: string): ChatMessage => ({
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
    const msgs = await listMessages('19:abc@unq.gbl.spaces')
    expect(msgs.map((x) => x.id)).toEqual(['oldest', 'middle', 'latest'])
  })

  test('does not mutate the response array order', async () => {
    primeAuth()
    const original: ChatMessage[] = [
      { id: 'b', createdDateTime: '2026-04-29T09:10:00Z', body: { contentType: 'text', content: 'b' } },
      { id: 'a', createdDateTime: '2026-04-29T09:00:00Z', body: { contentType: 'text', content: 'a' } },
    ]
    __setTransportForTests(async () => jsonResponse({ value: original }))
    await listMessages('19:abc@unq.gbl.spaces')
    expect(original.map((x) => x.id)).toEqual(['b', 'a'])
  })
})

describe('sendMessage', () => {
  test('POSTs Graph-wrapped {body: {contentType: text, content}}', async () => {
    primeAuth()
    let seenMethod = ''
    let seenBody = ''
    let seenUrl = ''
    __setTransportForTests(async (url, init) => {
      seenUrl = url
      seenMethod = init.method ?? ''
      seenBody = typeof init.body === 'string' ? init.body : ''
      return jsonResponse({
        ...SAMPLE_MESSAGE,
        id: 'new-id',
        body: { contentType: 'text', content: 'hello' },
      })
    })
    const created = await sendMessage('19:abc@unq.gbl.spaces', 'hello')
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toBe(
      'https://graph.microsoft.com/v1.0/chats/19%3Aabc%40unq.gbl.spaces/messages',
    )
    expect(JSON.parse(seenBody)).toEqual({
      body: { contentType: 'text', content: 'hello' },
    })
    expect(created.id).toBe('new-id')
  })

  test('preserves multi-line content and unicode verbatim', async () => {
    primeAuth()
    let seenBody = ''
    __setTransportForTests(async (_url, init) => {
      seenBody = typeof init.body === 'string' ? init.body : ''
      return jsonResponse({ ...SAMPLE_MESSAGE, body: { contentType: 'text', content: '' } })
    })
    const content = 'first line\nsecond line\nNo - emdash 🙃 — wait, that one is allowed in user content'
    await sendMessage('19:abc@unq.gbl.spaces', content)
    expect(JSON.parse(seenBody).body.content).toBe(content)
  })

  test('forwards AbortSignal', async () => {
    primeAuth()
    let seenSignal: AbortSignal | undefined
    __setTransportForTests(async (_url, init) => {
      seenSignal = init.signal ?? undefined
      return jsonResponse(SAMPLE_MESSAGE)
    })
    const ctrl = new AbortController()
    await sendMessage('19:abc@unq.gbl.spaces', 'hi', { signal: ctrl.signal })
    expect(seenSignal).toBe(ctrl.signal)
  })
})
