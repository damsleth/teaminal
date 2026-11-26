import { describe, expect, jest, test } from 'bun:test'
import {
  buildRegistrarRequest,
  buildTrouterConnectUrl,
  parseSocketIoEvent,
  resolveSkypeAuth,
  TrouterTransport,
} from './trouter'
import { RealtimeEventBus } from './events'
import { subscribeEvents } from '../log'

function makeDummyTransport() {
  const bus = new RealtimeEventBus()
  const transport = new TrouterTransport({
    bus,
    getToken: async () => 'fake-token',
    profile: undefined,
  })
  return { bus, transport }
}

describe('TrouterTransport frame parsing', () => {
  test('builds the HAR-matched /v4/c websocket URL from a regional trouter URL', () => {
    const url = buildTrouterConnectUrl('https://go-eu.trouter.teams.microsoft.com/v4/a', 'reg-1')
    expect(url).toStartWith('wss://go-eu.trouter.teams.microsoft.com/v4/c?')
    expect(url).toContain('epid=reg-1')
    expect(url).toContain('dom=teams.microsoft.com')
    expect(decodeURIComponent(url)).toContain('"ua":"SkypeSpaces"')
  })

  test('parses Socket.IO event packets', () => {
    expect(
      parseSocketIoEvent('5:1+::{"name":"trouter.message_loss","args":[{"tag":"messaging"}]}'),
    ).toEqual({
      id: '1',
      expectsAck: true,
      event: { name: 'trouter.message_loss', args: [{ tag: 'messaging' }] },
    })
  })

  test('parses empty string as ping', () => {
    const { transport } = makeDummyTransport()
    expect(transport.parseFrame('')).toEqual({ type: 'ping' })
    expect(transport.parseFrame('   ')).toEqual({ type: 'ping' })
  })

  test('parses explicit ping type', () => {
    const { transport } = makeDummyTransport()
    expect(transport.parseFrame('{"type":"ping"}')).toEqual({ type: 'ping' })
    expect(transport.parseFrame('{"type":"noop"}')).toEqual({ type: 'ping' })
  })

  test('parses non-JSON as unknown', () => {
    const { transport } = makeDummyTransport()
    const result = transport.parseFrame('not-json')
    expect(result.type).toBe('unknown')
  })

  test('parses event with eventType', () => {
    const { transport } = makeDummyTransport()
    const result = transport.parseFrame(
      JSON.stringify({ eventType: 'NewMessage', resource: '/chats/c1/messages' }),
    )
    expect(result.type).toBe('event')
  })

  test('parses nested body frame', () => {
    const { transport } = makeDummyTransport()
    const result = transport.parseFrame(
      JSON.stringify({
        body: { eventType: 'PresenceChange', resourceData: { userId: 'u1', availability: 'Away' } },
      }),
    )
    expect(result.type).toBe('event')
    if (result.type === 'event') {
      expect(result.body.eventType).toBe('PresenceChange')
    }
  })

  test('non-object JSON returns unknown', () => {
    const { transport } = makeDummyTransport()
    expect(transport.parseFrame('42')).toEqual({ type: 'unknown', raw: '42' })
    expect(transport.parseFrame('"hello"')).toEqual({ type: 'unknown', raw: '"hello"' })
    expect(transport.parseFrame('null')).toEqual({ type: 'unknown', raw: 'null' })
  })

  test('object without event fields returns unknown', () => {
    const { transport } = makeDummyTransport()
    const result = transport.parseFrame(JSON.stringify({ foo: 'bar' }))
    expect(result.type).toBe('unknown')
  })
})

describe('TrouterTransport event mapping', () => {
  test('maps NewMessage eventType to new-message', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'NewMessage',
      resource: "/chats('19:abc@thread.v2')/messages",
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('new-message')
    if (events[0]!.kind === 'new-message') {
      expect(events[0]!.chatId).toBe('19:abc@thread.v2')
    }
  })

  test('maps typing eventType', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'SetTyping',
      resource: "/chats('c1')/messages",
      resourceData: { userId: 'u1', displayName: 'Alice' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'typing',
      chatId: 'c1',
      userId: 'u1',
      displayName: 'Alice',
    })
  })

  test('maps clear-typing to typing-stopped', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'ClearTyping',
      resource: "/chats('c1')/messages",
      resourceData: { userId: 'u1' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('typing-stopped')
  })

  test('maps presence change', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'PresenceChange',
      resourceData: { userId: 'u1', availability: 'Away' },
    })
    expect(events).toEqual([{ kind: 'presence-changed', userId: 'u1', availability: 'Away' }])
  })

  test('maps read receipt', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'ReadReceipt',
      resource: "/chats('c1')/messages",
      resourceData: { userId: 'u1', messageId: 'm1' },
    })
    expect(events).toEqual([{ kind: 'read-receipt', chatId: 'c1', userId: 'u1', messageId: 'm1' }])
  })

  test('maps message edit', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'MessageUpdated',
      resource: "/chats('c1')/messages",
      resourceData: { messageId: 'm1' },
    })
    expect(events).toEqual([{ kind: 'message-edited', chatId: 'c1', messageId: 'm1' }])
  })

  test('maps message delete', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'MessageDeleted',
      resource: "/chats('c1')/messages",
      resourceData: { messageId: 'm1' },
    })
    expect(events).toEqual([{ kind: 'message-deleted', chatId: 'c1', messageId: 'm1' }])
  })

  test('maps reaction', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'ReactionAdded',
      resource: "/chats('c1')/messages",
      resourceData: { messageId: 'm1' },
    })
    expect(events).toEqual([{ kind: 'reaction-added', chatId: 'c1', messageId: 'm1' }])
  })

  test('maps member joined', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'MemberJoined',
      resource: "/chats('c1')/members",
      resourceData: { userId: 'u1' },
    })
    expect(events).toEqual([{ kind: 'member-joined', chatId: 'c1', userId: 'u1' }])
  })

  test('maps member left', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'MemberRemoved',
      resource: "/chats('c1')/members",
      resourceData: { userId: 'u1' },
    })
    expect(events).toEqual([{ kind: 'member-left', chatId: 'c1', userId: 'u1' }])
  })

  test('maps chat update', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'ThreadUpdate',
      resource: "/chats('c1')",
      resourceData: { chatId: 'c1' },
    })
    expect(events).toEqual([{ kind: 'chat-updated', chatId: 'c1' }])
  })

  test('returns empty for unrecognized events', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'SomeFutureEvent',
      resourceData: {},
    })
    expect(events).toEqual([])
  })

  test('extracts chatId from parenthesized resource path', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'MessageCreated',
      resource: "/chats('19:meeting_abc@thread.v2')/messages('m1')",
    })
    expect(events).toHaveLength(1)
    if (events[0]!.kind === 'new-message') {
      expect(events[0]!.chatId).toBe('19:meeting_abc@thread.v2')
    }
  })

  test('extracts chatId from slash-style resource path', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'NewMessage',
      resource: '/chats/19:abc@thread.v2/messages',
    })
    expect(events).toHaveLength(1)
    if (events[0]!.kind === 'new-message') {
      expect(events[0]!.chatId).toBe('19:abc@thread.v2')
    }
  })

  test('falls back to resourceData.chatId when resource path has no chatId', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'NewMessage',
      resource: '/messages',
      resourceData: { chatId: 'fallback-id' },
    })
    expect(events).toHaveLength(1)
    if (events[0]!.kind === 'new-message') {
      expect(events[0]!.chatId).toBe('fallback-id')
    }
  })

  test('new-message includes senderId from fromId', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'NewMessage',
      resource: "/chats('c1')/messages",
      resourceData: { fromId: 'sender-1' },
    })
    expect(events).toHaveLength(1)
    if (events[0]!.kind === 'new-message') {
      expect(events[0]!.senderId).toBe('sender-1')
    }
  })

  test('typing uses fromId as fallback for userId', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'SetTyping',
      resource: "/chats('c1')/typing",
      resourceData: { fromId: 'u1', imdisplayname: 'Bob' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'typing',
      chatId: 'c1',
      userId: 'u1',
      displayName: 'Bob',
    })
  })

  test('presence uses status field as fallback for availability', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'EndpointPresence',
      resourceData: { id: 'u2', status: 'DoNotDisturb' },
    })
    expect(events).toEqual([
      { kind: 'presence-changed', userId: 'u2', availability: 'DoNotDisturb' },
    ])
  })

  test('member uses memberId as fallback for userId', () => {
    const { transport } = makeDummyTransport()
    const events = transport.mapToRealtimeEvents({
      eventType: 'MemberAdded',
      resource: "/chats('c1')/members",
      resourceData: { memberId: 'u3' },
    })
    expect(events).toEqual([{ kind: 'member-joined', chatId: 'c1', userId: 'u3' }])
  })

  test('returns empty when required fields are missing', () => {
    const { transport } = makeDummyTransport()
    // typing without userId — falls through to new-message via /messages resource
    const typingNoUser = transport.mapToRealtimeEvents({
      eventType: 'SetTyping',
      resource: "/chats('c1')/messages",
      resourceData: {},
    })
    expect(typingNoUser).toHaveLength(1)
    expect(typingNoUser[0]!.kind).toBe('new-message')

    // presence without userId
    expect(
      transport.mapToRealtimeEvents({
        eventType: 'PresenceChange',
        resourceData: { availability: 'Away' },
      }),
    ).toEqual([])
    // new-message without chatId
    expect(
      transport.mapToRealtimeEvents({
        eventType: 'NewMessage',
        resource: '/other',
        resourceData: {},
      }),
    ).toEqual([])
  })
})

describe('TrouterTransport state', () => {
  test('starts in disconnected state', () => {
    const { transport } = makeDummyTransport()
    expect(transport.state).toBe('disconnected')
  })

  test('disconnect is idempotent', () => {
    const { transport } = makeDummyTransport()
    transport.disconnect()
    transport.disconnect()
    expect(transport.state).toBe('disconnected')
  })

  test('onStateChange fires on state transitions', () => {
    const { transport } = makeDummyTransport()
    const states: string[] = []
    transport.onStateChange((s) => states.push(s))
    // disconnect from disconnected should be a no-op (same state)
    transport.disconnect()
    expect(states).toEqual([])
  })

  test('onStateChange unsubscribe works', () => {
    const { transport } = makeDummyTransport()
    const states: string[] = []
    const unsub = transport.onStateChange((s) => states.push(s))
    unsub()
    transport.disconnect()
    expect(states).toEqual([])
  })
})

describe('resolveSkypeAuth', () => {
  test('returns the minted token when authsvc answers', async () => {
    expect(await resolveSkypeAuth(async () => 'skype-abc')).toEqual({
      skypeToken: 'skype-abc',
      unavailable: false,
    })
  })

  test('a walled-off authsvc yields no token instead of throwing', async () => {
    // 410 ApiRestricted must not abort the connect: registrar authorizes on
    // the IC3 Bearer token, so push works without a Skype token.
    expect(
      await resolveSkypeAuth(async () => {
        throw new Error('teams authz 410: {"errorCode":"ApiRestricted"}')
      }),
    ).toEqual({ skypeToken: null, unavailable: true })
  })
})

describe('buildRegistrarRequest', () => {
  const base = { path: 'https://pub-x-f.trouter/v4/f/sr-1/', registrationId: 'reg-1' }

  test('authorizes with the IC3 bearer token', () => {
    const { url, init } = buildRegistrarRequest({ ...base, ic3Token: 'ic3-tok', skypeToken: null })
    expect(url).toBe('https://teams.microsoft.com/registrar/prod/V2/registrations')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ic3-tok')
    // No Skype token available — the header must be absent, not empty.
    expect('x-skypetoken' in headers).toBe(false)
    const body = JSON.parse(init.body as string)
    expect(body.registrationId).toBe('reg-1')
    expect(body.transports.TROUTER[0].path).toBe(base.path)
  })

  test('sends x-skypetoken as well when the exchange succeeded', () => {
    const { init } = buildRegistrarRequest({ ...base, ic3Token: 'ic3-tok', skypeToken: 'skype-1' })
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ic3-tok')
    expect(headers['x-skypetoken']).toBe('skype-1')
  })
})

// A WebSocket stand-in. close() fires onclose on a microtask, like a real
// socket, or only on fireClose() ('manual'), so a test can put the close
// before or after the failed connect's rejection is handled.
class FakeSocket {
  static OPEN = 1
  static made: FakeSocket[] = []
  static closeMode: 'microtask' | 'manual' = 'microtask'
  readyState = 0
  closed = false
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  constructor(public url: string) {
    FakeSocket.made.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    if (FakeSocket.closeMode === 'microtask') queueMicrotask(() => this.fireClose())
  }
  fireClose(code = 1006) {
    this.onclose?.({ code, reason: '' })
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  receive(data: string) {
    this.onmessage?.({ data })
  }
}

const flush = async (n = 50) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

const fakeResponse = (status: number, body = '') =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers(),
    body: null,
    text: async () => body,
  }) as unknown as Response

const CONNECTED_FRAME = `5:1::${JSON.stringify({
  name: 'trouter.connected',
  args: [{ surl: 'https://trouter.example.com/v4/f/sr-1/', connectparams: { st: 'fake' } }],
})}`

type FetchStub = (url: string, init: RequestInit) => Promise<Response>

// Fake sockets, fake timers, a fixed jitter and a fetch that refuses
// anything a test did not stub: nothing here reaches the network.
async function withHarness(
  fn: (h: { setFetch: (f: FetchStub) => void; fetchCalls: () => number }) => Promise<void>,
): Promise<void> {
  const real = { ws: globalThis.WebSocket, fetch: globalThis.fetch, random: Math.random }
  FakeSocket.made = []
  FakeSocket.closeMode = 'microtask'
  let impl: FetchStub = async () => {
    throw new Error('test: unexpected network call')
  }
  let calls = 0
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls++
    return impl(String(url), init ?? {})
  }) as unknown as typeof fetch
  Math.random = () => 0.5
  jest.useFakeTimers()
  try {
    await fn({ setFetch: (f) => (impl = f), fetchCalls: () => calls })
  } finally {
    jest.useRealTimers()
    globalThis.WebSocket = real.ws
    globalThis.fetch = real.fetch
    Math.random = real.random
  }
}

function makeTransport(profile = 'alpha', token = 'ic3-tok') {
  const transport = new TrouterTransport({
    bus: new RealtimeEventBus(),
    getToken: async () => token,
    profile,
  })
  ;(transport as unknown as { ensureSkypeToken: () => Promise<void> }).ensureSkypeToken =
    async () => {}
  return transport
}

// Start a connect and return its socket (not yet open).
async function startConnect(transport: TrouterTransport): Promise<FakeSocket> {
  const before = FakeSocket.made.length
  void transport.connect()
  await flush()
  expect(FakeSocket.made).toHaveLength(before + 1)
  return FakeSocket.made[before]!
}

// Upgrade, authenticate and deliver trouter.connected (the registrar POST).
async function handshake(sock: FakeSocket): Promise<void> {
  sock.open()
  sock.receive('1::')
  await flush()
  sock.receive(CONNECTED_FRAME)
  await flush()
}

describe('TrouterTransport shutdown', () => {
  function setupTransport() {
    FakeSocket.made = []
    let release!: (t: string) => void
    const transport = new TrouterTransport({
      bus: new RealtimeEventBus(),
      getToken: () => new Promise<string>((r) => (release = r)),
      profile: undefined,
    })
    ;(transport as unknown as { ensureSkypeToken: () => Promise<void> }).ensureSkypeToken =
      async () => {}
    return { transport, release: (t: string) => release(t) }
  }

  test('a disconnect during the token await opens no socket afterwards', async () => {
    const real = globalThis.WebSocket
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    try {
      const { transport, release } = setupTransport()
      const connecting = transport.connect()
      await Promise.resolve()
      transport.disconnect()
      release('tok')
      await connecting
      expect(FakeSocket.made).toHaveLength(0)
      expect(transport.state).toBe('disconnected')
    } finally {
      globalThis.WebSocket = real
    }
  })

  test('a disconnect while the socket is opening closes it', async () => {
    const real = globalThis.WebSocket
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    try {
      const { transport, release } = setupTransport()
      void transport.connect()
      await Promise.resolve()
      release('tok')
      for (let i = 0; i < 10 && FakeSocket.made.length === 0; i++) await Promise.resolve()
      expect(FakeSocket.made).toHaveLength(1)
      transport.disconnect()
      expect(FakeSocket.made[0]!.closed).toBe(true)
      // A late open on the stale socket must not revive it.
      FakeSocket.made[0]!.onopen?.()
      expect(transport.state).toBe('disconnected')
    } finally {
      globalThis.WebSocket = real
    }
  })
})

describe('TrouterTransport lifecycle', () => {
  for (const mode of ['microtask', 'manual'] as const) {
    const order = mode === 'microtask' ? 'close before catch' : 'catch before close'
    test(`a registrar 500 leaves one pending reconnect, and none after disconnect (${order})`, () =>
      withHarness(async (h) => {
        FakeSocket.closeMode = mode
        h.setFetch(async () => fakeResponse(500))
        const t = makeTransport()
        const sock = await startConnect(t)
        await handshake(sock)
        if (mode === 'manual') {
          sock.fireClose()
          await flush()
        }
        expect(sock.closed).toBe(true)
        expect(t.state).toBe('reconnecting')
        expect(jest.getTimerCount()).toBe(1)
        t.disconnect()
        expect(jest.getTimerCount()).toBe(0)
        jest.advanceTimersByTime(10 * 60_000)
        await flush()
        expect(FakeSocket.made).toHaveLength(1)
        expect(t.state).toBe('disconnected')
      }))

    test(`no trouter.connected within 15 s gives one reconnect (${order})`, () =>
      withHarness(async () => {
        FakeSocket.closeMode = mode
        const t = makeTransport()
        const sock = await startConnect(t)
        sock.open()
        sock.receive('1::')
        await flush()
        jest.advanceTimersByTime(15_000)
        await flush()
        if (mode === 'manual') {
          sock.fireClose()
          await flush()
        }
        expect(sock.closed).toBe(true)
        expect(t.state).toBe('reconnecting')
        expect(jest.getTimerCount()).toBe(1)
        t.disconnect()
        jest.advanceTimersByTime(10 * 60_000)
        await flush()
        expect(FakeSocket.made).toHaveLength(1)
      }))
  }

  test('11 consecutive failures end in error with no timer; retry() starts over', () =>
    withHarness(async (h) => {
      h.setFetch(async () => fakeResponse(500))
      const giveUps: string[] = []
      const unsubscribe = subscribeEvents((e) => {
        if (e.message.includes('max reconnect attempts')) giveUps.push(e.message)
      })
      try {
        const t = makeTransport()
        await handshake(await startConnect(t))
        for (let i = 0; i < 10; i++) {
          expect(t.state).toBe('reconnecting')
          expect(jest.getTimerCount()).toBe(1)
          // Fire only the reconnect: a longer advance would also run the
          // next socket's 15 s timeout (bun drains microtasks in between).
          jest.advanceTimersToNextTimer()
          await flush()
          await handshake(FakeSocket.made.at(-1)!)
        }
        expect(FakeSocket.made).toHaveLength(11)
        expect(t.state).toBe('error')
        expect(jest.getTimerCount()).toBe(0)
        expect(giveUps).toHaveLength(1)

        t.retry()
        expect(t.state).toBe('connecting')
        await flush()
        expect(FakeSocket.made).toHaveLength(12)
        await handshake(FakeSocket.made.at(-1)!)
        expect(t.state).toBe('reconnecting')
        // The attempt count was reset: the next delay is the 2 s base again.
        jest.advanceTimersByTime(1_999)
        await flush()
        expect(FakeSocket.made).toHaveLength(12)
        jest.advanceTimersByTime(1)
        await flush()
        expect(FakeSocket.made).toHaveLength(13)
        t.disconnect()
      } finally {
        unsubscribe()
      }
    }))

  test('a disconnect while the registrar POST is pending aborts it', () =>
    withHarness(async (h) => {
      let signal: AbortSignal | undefined
      h.setFetch(
        (_url, init) =>
          new Promise((_, reject) => {
            signal = init.signal!
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          }),
      )
      const t = makeTransport()
      await handshake(await startConnect(t))
      expect(signal?.aborted).toBe(false)
      t.disconnect()
      await flush()
      expect(signal?.aborted).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
      jest.advanceTimersByTime(10 * 60_000)
      await flush()
      expect(FakeSocket.made).toHaveLength(1)
      expect(t.state).toBe('disconnected')
    }))

  test('trouter.message_loss is acknowledged with its packet id', () =>
    withHarness(async () => {
      const t = makeTransport()
      const sock = await startConnect(t)
      sock.open()
      sock.receive('5:7+::{"name":"trouter.message_loss","args":[{"tag":"messaging"}]}')
      await flush()
      expect(sock.sent).toEqual([
        '5:7+::{"name":"trouter.processed_message_loss","args":[{"tag":"messaging"}]}',
      ])
      t.disconnect()
    }))

  test('1:: sends user.authenticate; 2:: is echoed', () =>
    withHarness(async () => {
      const t = makeTransport()
      const sock = await startConnect(t)
      sock.open()
      sock.receive('1::')
      await flush()
      expect(sock.sent).toHaveLength(1)
      const auth = JSON.parse(sock.sent[0]!.replace(/^5:::/, ''))
      expect(auth.name).toBe('user.authenticate')
      expect(auth.args[0].headers.Authorization).toBe('Bearer ic3-tok')
      sock.receive('2::')
      await flush()
      expect(sock.sent[1]).toBe('2::')
      t.disconnect()
    }))

  test('after registration a malformed frame only logs, and disconnect stops the keepalive', () =>
    withHarness(async (h) => {
      h.setFetch(async () => fakeResponse(200))
      const t = makeTransport()
      const sock = await startConnect(t)
      await handshake(sock)
      expect(t.state).toBe('connected')
      sock.receive('5:::{"name":"x","args":[{"eventType":"NewMessage","resource":42}]}')
      await flush()
      expect(t.state).toBe('connected')
      expect(sock.closed).toBe(false)
      expect(jest.getTimerCount()).toBe(1) // the keepalive only
      t.disconnect()
      const sent = sock.sent.length
      jest.advanceTimersByTime(60_000)
      await flush()
      expect(sock.sent).toHaveLength(sent)
      expect(jest.getTimerCount()).toBe(0)
    }))

  test("a registrar failure and disconnect on A leave B's socket and timers alone", () =>
    withHarness(async (h) => {
      h.setFetch(async (_url, init) =>
        fakeResponse(
          (init.headers as Record<string, string>).authorization === 'Bearer tok-a' ? 500 : 200,
        ),
      )
      const a = makeTransport('alpha', 'tok-a')
      const b = makeTransport('beta', 'tok-b')
      const sockA = await startConnect(a)
      const sockB = await startConnect(b)
      await handshake(sockB)
      expect(b.state).toBe('connected')
      await handshake(sockA)
      expect(a.state).toBe('reconnecting')
      a.disconnect()
      jest.advanceTimersByTime(10 * 60_000)
      await flush()
      expect(FakeSocket.made).toHaveLength(2)
      expect(a.state).toBe('disconnected')
      expect(sockB.closed).toBe(false)
      expect(b.state).toBe('connected')
      expect(jest.getTimerCount()).toBe(1) // B's keepalive
      expect(sockB.sent.filter((s) => s === '2::').length).toBe(20)
      b.disconnect()
    }))

  test('a frame on a superseded socket sends nothing on the current one and does not register', () =>
    withHarness(async (h) => {
      h.setFetch(async () => fakeResponse(200))
      const t = makeTransport()
      const s1 = await startConnect(t)
      s1.open()
      const stale = s1.onmessage!
      t.retry()
      await flush()
      const s2 = FakeSocket.made[1]!
      s2.open()
      stale({ data: '1::' })
      stale({ data: CONNECTED_FRAME })
      await flush()
      expect(s2.sent).toEqual([])
      expect(h.fetchCalls()).toBe(0)
      expect(t.state).toBe('connecting')
      t.disconnect()
    }))
})
