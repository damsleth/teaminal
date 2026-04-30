import { describe, expect, test } from 'bun:test'
import { RealtimeEventBus, type RealtimeEvent } from './events'

describe('RealtimeEventBus', () => {
  test('on() receives all emitted events', () => {
    const bus = new RealtimeEventBus()
    const received: RealtimeEvent[] = []
    bus.on((e) => received.push(e))

    bus.emit({ kind: 'new-message', chatId: 'c1' })
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1' })

    expect(received).toHaveLength(2)
    expect(received[0]!.kind).toBe('new-message')
    expect(received[1]!.kind).toBe('typing')
  })

  test('onKind() only receives matching events', () => {
    const bus = new RealtimeEventBus()
    const typing: RealtimeEvent[] = []
    bus.onKind('typing', (e) => typing.push(e))

    bus.emit({ kind: 'new-message', chatId: 'c1' })
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1' })
    bus.emit({ kind: 'typing-stopped', chatId: 'c1', userId: 'u1' })

    expect(typing).toHaveLength(1)
    expect(typing[0]!.kind).toBe('typing')
  })

  test('unsubscribe stops delivery', () => {
    const bus = new RealtimeEventBus()
    const received: RealtimeEvent[] = []
    const unsub = bus.on((e) => received.push(e))

    bus.emit({ kind: 'new-message', chatId: 'c1' })
    unsub()
    bus.emit({ kind: 'new-message', chatId: 'c2' })

    expect(received).toHaveLength(1)
  })

  test('onKind unsubscribe stops delivery for that kind', () => {
    const bus = new RealtimeEventBus()
    const received: RealtimeEvent[] = []
    const unsub = bus.onKind('typing', (e) => received.push(e))

    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1' })
    unsub()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u2' })

    expect(received).toHaveLength(1)
  })

  test('clear() removes all listeners', () => {
    const bus = new RealtimeEventBus()
    const all: RealtimeEvent[] = []
    const kind: RealtimeEvent[] = []
    bus.on((e) => all.push(e))
    bus.onKind('new-message', (e) => kind.push(e))

    bus.emit({ kind: 'new-message', chatId: 'c1' })
    expect(all).toHaveLength(1)
    expect(kind).toHaveLength(1)

    bus.clear()
    bus.emit({ kind: 'new-message', chatId: 'c2' })
    expect(all).toHaveLength(1)
    expect(kind).toHaveLength(1)
  })

  test('multiple kind listeners for different kinds', () => {
    const bus = new RealtimeEventBus()
    const messages: RealtimeEvent[] = []
    const presence: RealtimeEvent[] = []
    bus.onKind('new-message', (e) => messages.push(e))
    bus.onKind('presence-changed', (e) => presence.push(e))

    bus.emit({ kind: 'new-message', chatId: 'c1' })
    bus.emit({ kind: 'presence-changed', userId: 'u1', availability: 'Available' })
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1' })

    expect(messages).toHaveLength(1)
    expect(presence).toHaveLength(1)
  })

  test('both on() and onKind() fire for the same event', () => {
    const bus = new RealtimeEventBus()
    const all: RealtimeEvent[] = []
    const kind: RealtimeEvent[] = []
    bus.on((e) => all.push(e))
    bus.onKind('new-message', (e) => kind.push(e))

    bus.emit({ kind: 'new-message', chatId: 'c1' })

    expect(all).toHaveLength(1)
    expect(kind).toHaveLength(1)
  })

  test('multiple onKind listeners on the same kind all fire', () => {
    const bus = new RealtimeEventBus()
    const a: RealtimeEvent[] = []
    const b: RealtimeEvent[] = []
    bus.onKind('typing', (e) => a.push(e))
    bus.onKind('typing', (e) => b.push(e))

    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1' })

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  test('emit with no listeners is a no-op', () => {
    const bus = new RealtimeEventBus()
    // Should not throw
    bus.emit({ kind: 'new-message', chatId: 'c1' })
    bus.emit({ kind: 'presence-changed', userId: 'u1', availability: 'Away' })
  })

  test('unsubscribing one onKind listener leaves others intact', () => {
    const bus = new RealtimeEventBus()
    const kept: RealtimeEvent[] = []
    const removed: RealtimeEvent[] = []
    bus.onKind('new-message', (e) => kept.push(e))
    const unsub = bus.onKind('new-message', (e) => removed.push(e))

    bus.emit({ kind: 'new-message', chatId: 'c1' })
    expect(kept).toHaveLength(1)
    expect(removed).toHaveLength(1)

    unsub()
    bus.emit({ kind: 'new-message', chatId: 'c2' })
    expect(kept).toHaveLength(2)
    expect(removed).toHaveLength(1)
  })
})
