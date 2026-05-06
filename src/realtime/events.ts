// Typed internal event bus for real-time signals.
//
// Decouples transport (trouter, SSE, future Graph subscriptions) from
// consumers (poller acceleration, typing indicators, presence). Any
// module can emit or subscribe without knowing the push source.

export type RealtimeEvent =
  | { kind: 'new-message'; chatId: string; senderId?: string }
  | { kind: 'typing'; chatId: string; userId: string; displayName?: string }
  | { kind: 'typing-stopped'; chatId: string; userId: string }
  | { kind: 'presence-changed'; userId: string; availability: string }
  | { kind: 'read-receipt'; chatId: string; userId: string; messageId: string }
  | { kind: 'chat-updated'; chatId: string }
  | { kind: 'chat-created'; chatId: string }
  | { kind: 'member-joined'; chatId: string; userId: string }
  | { kind: 'member-left'; chatId: string; userId: string }
  | { kind: 'message-edited'; chatId: string; messageId: string }
  | { kind: 'message-deleted'; chatId: string; messageId: string }
  | { kind: 'reaction-added'; chatId: string; messageId: string }
  | { kind: 'call-incoming'; chatId?: string; callerId?: string }

export type RealtimeEventKind = RealtimeEvent['kind']

export type RealtimeListener = (event: RealtimeEvent) => void

export class RealtimeEventBus {
  private listeners = new Set<RealtimeListener>()
  private kindListeners = new Map<RealtimeEventKind, Set<RealtimeListener>>()

  /** Subscribe to all events. Returns an unsubscribe function. */
  on(listener: RealtimeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Subscribe to a specific event kind. Returns an unsubscribe function. */
  onKind(kind: RealtimeEventKind, listener: RealtimeListener): () => void {
    let set = this.kindListeners.get(kind)
    if (!set) {
      set = new Set()
      this.kindListeners.set(kind, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) this.kindListeners.delete(kind)
    }
  }

  /** Emit an event to all matching listeners. */
  emit(event: RealtimeEvent): void {
    for (const l of this.listeners) l(event)
    const kindSet = this.kindListeners.get(event.kind)
    if (kindSet) {
      for (const l of kindSet) l(event)
    }
  }

  /** Remove all listeners. */
  clear(): void {
    this.listeners.clear()
    this.kindListeners.clear()
  }
}
