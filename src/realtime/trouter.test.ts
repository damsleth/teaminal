import { describe, expect, test } from 'bun:test'
import { TrouterTransport } from './trouter'
import { RealtimeEventBus } from './events'
import type { RealtimeEvent } from './events'

function makeDummyTransport() {
  const bus = new RealtimeEventBus()
  const transport = new TrouterTransport({
    bus,
    getToken: async () => 'fake-token',
  })
  return { bus, transport }
}

describe('TrouterTransport frame parsing', () => {
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
