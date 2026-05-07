import { describe, expect, test } from 'bun:test'
import { RealtimeEventBus } from '../realtime/events'
import { createAppStore } from './store'
import { startRealtimeBridge } from './realtimeBridge'

function setup() {
  const bus = new RealtimeEventBus()
  const store = createAppStore()
  let refreshCount = 0
  const fakePoller = {
    refresh: () => {
      refreshCount++
    },
    hardRefresh: () => {},
    stop: async () => {},
    loadOlderMessages: async () => ({
      conv: null,
      added: 0,
      fullyLoaded: true,
    }),
  }
  const bridge = startRealtimeBridge({
    bus,
    store,
    getPoller: () => fakePoller,
  })
  return { bus, store, bridge, getRefreshCount: () => refreshCount }
}

describe('realtimeBridge', () => {
  test('new-message event wakes the poller', () => {
    const { bus, bridge, getRefreshCount } = setup()
    bus.emit({ kind: 'new-message', chatId: 'c1' })
    expect(getRefreshCount()).toBe(1)
    bridge.stop()
  })

  test('chat-updated event wakes the poller', () => {
    const { bus, bridge, getRefreshCount } = setup()
    bus.emit({ kind: 'chat-updated', chatId: 'c1' })
    expect(getRefreshCount()).toBe(1)
    bridge.stop()
  })

  test('message-edited event wakes the poller', () => {
    const { bus, bridge, getRefreshCount } = setup()
    bus.emit({ kind: 'message-edited', chatId: 'c1', messageId: 'm1' })
    expect(getRefreshCount()).toBe(1)
    bridge.stop()
  })

  test('typing event adds to typingByConvo', () => {
    const { bus, store, bridge } = setup()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1', displayName: 'Alice' })

    const typing = store.get().typingByConvo['chat:c1']
    expect(typing).toHaveLength(1)
    expect(typing![0]!.userId).toBe('u1')
    expect(typing![0]!.displayName).toBe('Alice')
    bridge.stop()
  })

  test('typing event upserts existing entry', () => {
    const { bus, store, bridge } = setup()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1', displayName: 'Alice' })
    const t1 = store.get().typingByConvo['chat:c1']![0]!.startedAt

    // Small delay to get a different timestamp
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1', displayName: 'Alice' })
    const typing = store.get().typingByConvo['chat:c1']
    expect(typing).toHaveLength(1)
    expect(typing![0]!.startedAt).toBeGreaterThanOrEqual(t1)
    bridge.stop()
  })

  test('multiple users typing in same chat', () => {
    const { bus, store, bridge } = setup()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1', displayName: 'Alice' })
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u2', displayName: 'Bob' })

    const typing = store.get().typingByConvo['chat:c1']
    expect(typing).toHaveLength(2)
    bridge.stop()
  })

  test('typing-stopped removes the entry', () => {
    const { bus, store, bridge } = setup()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1', displayName: 'Alice' })
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u2', displayName: 'Bob' })
    bus.emit({ kind: 'typing-stopped', chatId: 'c1', userId: 'u1' })

    const typing = store.get().typingByConvo['chat:c1']
    expect(typing).toHaveLength(1)
    expect(typing![0]!.userId).toBe('u2')
    bridge.stop()
  })

  test('typing-stopped for last user removes the conv key', () => {
    const { bus, store, bridge } = setup()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1', displayName: 'Alice' })
    bus.emit({ kind: 'typing-stopped', chatId: 'c1', userId: 'u1' })

    expect(store.get().typingByConvo['chat:c1']).toBeUndefined()
    bridge.stop()
  })

  test('presence-changed updates myPresence for self', () => {
    const { bus, store, bridge } = setup()
    store.set({
      me: { id: 'me1', displayName: 'Me', userPrincipalName: 'me@test.com', mail: null },
    })
    bus.emit({ kind: 'presence-changed', userId: 'me1', availability: 'Away' })

    expect(store.get().myPresence?.availability).toBe('Away')
    bridge.stop()
  })

  test('presence-changed updates memberPresence for tracked users', () => {
    const { bus, store, bridge } = setup()
    store.set({
      me: { id: 'me1', displayName: 'Me', userPrincipalName: 'me@test.com', mail: null },
      memberPresence: {
        u1: { id: 'u1', availability: 'Available', activity: 'Available' },
      },
    })
    bus.emit({ kind: 'presence-changed', userId: 'u1', availability: 'Busy' })

    expect(store.get().memberPresence['u1']?.availability).toBe('Busy')
    bridge.stop()
  })

  test('presence-changed seeds memberPresence for previously-unseen users', () => {
    // The bridge has no view into which user ids the chat list cares
    // about, so seeding on push is the right default: it lets us light
    // up dots for users that the periodic poll has not yet covered
    // (e.g. a brand-new 1:1 chat created mid-session). The cost of an
    // unused map entry is negligible.
    const { bus, store, bridge } = setup()
    store.set({
      me: { id: 'me1', displayName: 'Me', userPrincipalName: 'me@test.com', mail: null },
    })
    bus.emit({ kind: 'presence-changed', userId: 'unknown', availability: 'Away' })

    expect(store.get().memberPresence['unknown']?.availability).toBe('Away')
    bridge.stop()
  })

  test('stop() prevents further event handling', () => {
    const { bus, store, bridge, getRefreshCount } = setup()
    bridge.stop()

    bus.emit({ kind: 'new-message', chatId: 'c1' })
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1' })

    expect(getRefreshCount()).toBe(0)
    expect(Object.keys(store.get().typingByConvo)).toHaveLength(0)
  })

  test('tolerates null poller during bootstrap', () => {
    const bus = new RealtimeEventBus()
    const store = createAppStore()
    const bridge = startRealtimeBridge({
      bus,
      store,
      getPoller: () => null,
    })

    // Should not throw
    bus.emit({ kind: 'new-message', chatId: 'c1' })
    bridge.stop()
  })

  test('chat-created event wakes the poller', () => {
    const { bus, bridge, getRefreshCount } = setup()
    bus.emit({ kind: 'chat-created', chatId: 'c1' })
    expect(getRefreshCount()).toBe(1)
    bridge.stop()
  })

  test('message-deleted event wakes the poller', () => {
    const { bus, bridge, getRefreshCount } = setup()
    bus.emit({ kind: 'message-deleted', chatId: 'c1', messageId: 'm1' })
    expect(getRefreshCount()).toBe(1)
    bridge.stop()
  })

  test('typing in different convos stays isolated', () => {
    const { bus, store, bridge } = setup()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1', displayName: 'Alice' })
    bus.emit({ kind: 'typing', chatId: 'c2', userId: 'u2', displayName: 'Bob' })

    expect(store.get().typingByConvo['chat:c1']).toHaveLength(1)
    expect(store.get().typingByConvo['chat:c2']).toHaveLength(1)
    expect(store.get().typingByConvo['chat:c1']![0]!.displayName).toBe('Alice')
    expect(store.get().typingByConvo['chat:c2']![0]!.displayName).toBe('Bob')
    bridge.stop()
  })

  test('typing-stopped for unknown user is a no-op', () => {
    const { bus, store, bridge } = setup()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1', displayName: 'Alice' })
    bus.emit({ kind: 'typing-stopped', chatId: 'c1', userId: 'unknown' })

    // u1 still present
    expect(store.get().typingByConvo['chat:c1']).toHaveLength(1)
    bridge.stop()
  })

  test('typing-stopped for conv with no prior typing is a no-op', () => {
    const { bus, store, bridge } = setup()
    bus.emit({ kind: 'typing-stopped', chatId: 'c99', userId: 'u1' })

    expect(store.get().typingByConvo['chat:c99']).toBeUndefined()
    bridge.stop()
  })

  test('typing without displayName falls back to userId', () => {
    const { bus, store, bridge } = setup()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'user-abc' })

    const typing = store.get().typingByConvo['chat:c1']
    expect(typing![0]!.displayName).toBe('user-abc')
    bridge.stop()
  })

  test('non-accelerating events do not wake poller', () => {
    const { bus, bridge, getRefreshCount } = setup()
    bus.emit({ kind: 'typing', chatId: 'c1', userId: 'u1' })
    bus.emit({ kind: 'typing-stopped', chatId: 'c1', userId: 'u1' })
    bus.emit({ kind: 'presence-changed', userId: 'u1', availability: 'Away' })
    bus.emit({ kind: 'read-receipt', chatId: 'c1', userId: 'u1', messageId: 'm1' })
    bus.emit({ kind: 'member-joined', chatId: 'c1', userId: 'u1' })
    bus.emit({ kind: 'member-left', chatId: 'c1', userId: 'u1' })

    expect(getRefreshCount()).toBe(0)
    bridge.stop()
  })

  test('read-receipt records latest seen message per user', () => {
    const { bus, store, bridge } = setup()

    bus.emit({ kind: 'read-receipt', chatId: 'c1', userId: 'u1', messageId: 'm1' })
    bus.emit({ kind: 'read-receipt', chatId: 'c1', userId: 'u1', messageId: 'm2' })
    bus.emit({ kind: 'read-receipt', chatId: 'c1', userId: 'u2', messageId: 'm1' })

    const receipts = store.get().readReceiptsByConvo['chat:c1']
    expect(receipts?.u1?.messageId).toBe('m2')
    expect(receipts?.u2?.messageId).toBe('m1')
    bridge.stop()
  })

  test('reaction-added wakes the poller (read-path acceleration)', () => {
    const { bus, bridge, getRefreshCount } = setup()
    bus.emit({ kind: 'reaction-added', chatId: 'c1', messageId: 'm1' })
    expect(getRefreshCount()).toBe(1)
    bridge.stop()
  })
})
