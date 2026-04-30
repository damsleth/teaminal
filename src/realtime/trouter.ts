// Trouter WebSocket transport for Microsoft Teams real-time events.
//
// Trouter is the internal push service used by Teams desktop/web clients.
// It delivers typing indicators, new-message signals, presence changes,
// read receipts, and more over a long-lived WebSocket.
//
// Protocol overview (reverse-engineered, not officially documented):
//   1. Exchange the Graph access token for a Skype token via the Teams
//      auth service endpoint.
//   2. Register a trouter endpoint, obtaining a WebSocket URL.
//   3. Open the WebSocket. Trouter sends JSON-framed events. The client
//      must respond to keepalive pings.
//   4. On disconnect, reconnect with exponential backoff.
//
// SECURITY: The Skype token is as sensitive as the Graph token. It is
// cached in-process only, never logged, never written to disk.

import { debug, warn } from '../log'
import type { RealtimeEventBus, RealtimeEvent } from './events'
import type {
  RealtimeTransport,
  TransportOpts,
  TransportState,
  TransportStateListener,
} from './transport'

const RECONNECT_BASE_MS = 2_000
const RECONNECT_CAP_MS = 60_000
const MAX_RECONNECT_ATTEMPTS = 10
const KEEPALIVE_INTERVAL_MS = 30_000

// Teams auth service endpoint for Skype token exchange.
const TEAMS_AUTHZ_URL = 'https://teams.microsoft.com/api/authsvc/v1.0/authz'

// Trouter registration URL template. The region is extracted from the
// authz response; this is the fallback for AMER.
const TROUTER_REGISTER_URL = 'https://go.trouter.teams.microsoft.com/v4/a'

export type TrouterFrame =
  | { type: 'ping' }
  | { type: 'event'; body: TrouterEventBody }
  | { type: 'unknown'; raw: string }

export type TrouterEventBody = {
  eventType?: string
  resource?: string
  resourceData?: Record<string, unknown>
  [key: string]: unknown
}

// Skype token + connection metadata from the Teams auth exchange.
type AuthzResult = {
  skypeToken: string
  expiresIn: number
  regionGtms?: {
    trouter?: string
    [key: string]: unknown
  }
}

export class TrouterTransport implements RealtimeTransport {
  private _state: TransportState = 'disconnected'
  private stateListeners = new Set<TransportStateListener>()
  private bus: RealtimeEventBus
  private getToken: () => Promise<string>
  private profile?: string

  private ws: WebSocket | null = null
  private skypeToken: string | null = null
  private skypeTokenExp = 0
  private trouterUrl: string | null = null
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private disconnecting = false

  constructor(opts: TransportOpts) {
    this.bus = opts.bus
    this.getToken = opts.getToken
    this.profile = opts.profile
  }

  get state(): TransportState {
    return this._state
  }

  onStateChange(listener: TransportStateListener): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  async connect(): Promise<void> {
    this.disconnecting = false
    this.setState('connecting')
    try {
      await this.ensureSkypeToken()
      await this.registerTrouter()
      await this.openWebSocket()
    } catch (err) {
      warn('trouter: connect failed:', err instanceof Error ? err.message : String(err))
      this.scheduleReconnect()
    }
  }

  disconnect(): void {
    this.disconnecting = true
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.setState('disconnected')
  }

  // --- Auth ---

  private async ensureSkypeToken(): Promise<void> {
    if (this.skypeToken && Date.now() / 1000 < this.skypeTokenExp - 60) return

    const graphToken = await this.getToken()
    const res = await fetch(TEAMS_AUTHZ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${graphToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Teams authz ${res.status}: ${text.slice(0, 200)}`)
    }

    const data = (await res.json()) as AuthzResult
    if (!data.skypeToken) {
      throw new Error('Teams authz response missing skypeToken')
    }

    this.skypeToken = data.skypeToken
    this.skypeTokenExp = Date.now() / 1000 + (data.expiresIn || 3600)
    this.trouterUrl = (data.regionGtms?.trouter as string | undefined) ?? TROUTER_REGISTER_URL

    debug('trouter: obtained skype token, expires in', data.expiresIn ?? '?', 's')
  }

  // --- Registration ---

  private async registerTrouter(): Promise<void> {
    const url = this.trouterUrl ?? TROUTER_REGISTER_URL

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Skypetoken': this.skypeToken!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientDescription: {
          appId: 'teaminal',
          platform: 'electron',
          templateKey: 'teaminal_1.0',
        },
        registrationId: crypto.randomUUID(),
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Trouter registration ${res.status}: ${text.slice(0, 200)}`)
    }

    const data = (await res.json()) as { socketio?: string; url?: string; [key: string]: unknown }
    const wsUrl = data.socketio ?? data.url
    if (!wsUrl) {
      throw new Error('Trouter registration response missing WebSocket URL')
    }

    this.trouterUrl = wsUrl
    debug('trouter: registered, ws url obtained')
  }

  // --- WebSocket ---

  private async openWebSocket(): Promise<void> {
    if (!this.trouterUrl) throw new Error('No trouter WebSocket URL')

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.trouterUrl!)

      ws.onopen = () => {
        debug('trouter: websocket connected')
        this.ws = ws
        this.reconnectAttempts = 0
        this.setState('connected')
        this.startKeepalive()
        resolve()
      }

      ws.onmessage = (event) => {
        try {
          const frame = this.parseFrame(String(event.data))
          this.handleFrame(frame)
        } catch (err) {
          debug('trouter: frame parse error:', err instanceof Error ? err.message : String(err))
        }
      }

      ws.onerror = (event) => {
        const msg = (event as ErrorEvent).message ?? 'unknown'
        warn('trouter: websocket error:', msg)
      }

      ws.onclose = () => {
        debug('trouter: websocket closed')
        this.ws = null
        this.clearKeepalive()
        if (!this.disconnecting) {
          this.scheduleReconnect()
        }
      }

      // Reject if connection doesn't open within 15s.
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close()
          reject(new Error('trouter: websocket connection timeout'))
        }
      }, 15_000)
    })
  }

  // --- Frame parsing ---

  parseFrame(raw: string): TrouterFrame {
    if (!raw || raw.trim() === '') return { type: 'ping' }

    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return { type: 'unknown', raw }
    }

    if (!data || typeof data !== 'object') return { type: 'unknown', raw }

    const obj = data as Record<string, unknown>

    // Trouter pings are often empty or have a specific type field.
    if (obj.type === 'ping' || obj.type === 'noop') return { type: 'ping' }

    // Extract the event body from various trouter frame shapes.
    // Some frames nest the event under a 'body' key; otherwise treat the
    // top-level object itself as the event body.
    const body = (
      typeof obj.body === 'object' && obj.body !== null ? obj.body : obj
    ) as TrouterEventBody
    if (body.eventType || body.resource || body.resourceData) {
      return { type: 'event', body }
    }

    return { type: 'unknown', raw }
  }

  private handleFrame(frame: TrouterFrame): void {
    if (frame.type === 'ping') {
      this.sendPong()
      return
    }

    if (frame.type !== 'event') return

    const events = this.mapToRealtimeEvents(frame.body)
    for (const event of events) {
      this.bus.emit(event)
    }
  }

  /** Map a trouter event body to zero or more RealtimeEvents. */
  mapToRealtimeEvents(body: TrouterEventBody): RealtimeEvent[] {
    const eventType = (body.eventType ?? '').toLowerCase()
    const resource = (body.resource ?? '').toLowerCase()
    const resourceData = body.resourceData ?? {}

    // Typing indicator — check before new-message since typing events
    // also have /messages in their resource path.
    if (eventType.includes('typing') || eventType.includes('settyping')) {
      const chatId = extractChatId(resource) ?? (resourceData.chatId as string | undefined)
      const userId = (resourceData.userId ?? resourceData.fromId) as string | undefined
      const displayName = (resourceData.displayName ?? resourceData.imdisplayname) as
        | string
        | undefined
      if (chatId && userId) {
        const stopped = eventType.includes('cleartyping') || eventType.includes('typingstopped')
        return [
          stopped
            ? { kind: 'typing-stopped', chatId, userId }
            : { kind: 'typing', chatId, userId, displayName },
        ]
      }
    }

    // Read receipt.
    if (eventType.includes('readreceipt') || eventType.includes('messageread')) {
      const chatId = extractChatId(resource) ?? (resourceData.chatId as string | undefined)
      const userId = (resourceData.userId ?? resourceData.fromId) as string | undefined
      const messageId = (resourceData.messageId ?? resourceData.id) as string | undefined
      if (chatId && userId && messageId) {
        return [{ kind: 'read-receipt', chatId, userId, messageId }]
      }
    }

    // Message edit.
    if (eventType.includes('messageupdated') || eventType.includes('messageedited')) {
      const chatId = extractChatId(resource) ?? (resourceData.chatId as string | undefined)
      const messageId = (resourceData.messageId ?? resourceData.id) as string | undefined
      if (chatId && messageId) {
        return [{ kind: 'message-edited', chatId, messageId }]
      }
    }

    // Message delete.
    if (eventType.includes('messagedeleted') || eventType.includes('messageremoved')) {
      const chatId = extractChatId(resource) ?? (resourceData.chatId as string | undefined)
      const messageId = (resourceData.messageId ?? resourceData.id) as string | undefined
      if (chatId && messageId) {
        return [{ kind: 'message-deleted', chatId, messageId }]
      }
    }

    // Reaction.
    if (eventType.includes('reaction')) {
      const chatId = extractChatId(resource) ?? (resourceData.chatId as string | undefined)
      const messageId = (resourceData.messageId ?? resourceData.id) as string | undefined
      if (chatId && messageId) {
        return [{ kind: 'reaction-added', chatId, messageId }]
      }
    }

    // Presence change.
    if (eventType.includes('presencechange') || eventType.includes('endpointpresence')) {
      const userId = (resourceData.userId ?? resourceData.id) as string | undefined
      const availability = (resourceData.availability ?? resourceData.status) as string | undefined
      if (userId && availability) {
        return [{ kind: 'presence-changed', userId, availability }]
      }
    }

    // New message in a chat — checked after more specific event types
    // since the resource path '/messages' is shared by typing, read
    // receipt, edit, delete, and reaction events.
    if (
      eventType.includes('newmessage') ||
      eventType.includes('messagecreated') ||
      resource.includes('/messages')
    ) {
      const chatId = extractChatId(resource) ?? (resourceData.chatId as string | undefined)
      if (chatId) {
        return [
          {
            kind: 'new-message',
            chatId,
            senderId: resourceData.fromId as string | undefined,
          },
        ]
      }
    }

    // Member changes.
    if (eventType.includes('memberjoined') || eventType.includes('memberadded')) {
      const chatId = extractChatId(resource) ?? (resourceData.chatId as string | undefined)
      const userId = (resourceData.userId ?? resourceData.memberId) as string | undefined
      if (chatId && userId) {
        return [{ kind: 'member-joined', chatId, userId }]
      }
    }
    if (eventType.includes('memberleft') || eventType.includes('memberremoved')) {
      const chatId = extractChatId(resource) ?? (resourceData.chatId as string | undefined)
      const userId = (resourceData.userId ?? resourceData.memberId) as string | undefined
      if (chatId && userId) {
        return [{ kind: 'member-left', chatId, userId }]
      }
    }

    // Chat created / updated.
    if (eventType.includes('threadupdate') || eventType.includes('chatupdate')) {
      const chatId = extractChatId(resource) ?? (resourceData.chatId as string | undefined)
      if (chatId) {
        return [{ kind: 'chat-updated', chatId }]
      }
    }

    return []
  }

  // --- Keepalive ---

  private startKeepalive(): void {
    this.clearKeepalive()
    this.keepaliveTimer = setInterval(() => {
      this.sendPong()
    }, KEEPALIVE_INTERVAL_MS)
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private sendPong(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'pong' }))
      } catch {
        // swallow
      }
    }
  }

  // --- Reconnect ---

  private scheduleReconnect(): void {
    if (this.disconnecting) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      warn('trouter: max reconnect attempts reached, giving up')
      this.setState('error')
      return
    }

    this.setState('reconnecting')
    const delay = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * Math.pow(1.5, this.reconnectAttempts),
    )
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4))
    this.reconnectAttempts++

    debug(`trouter: reconnecting in ${jittered}ms (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, jittered)
  }

  private clearTimers(): void {
    this.clearKeepalive()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // --- State ---

  private setState(next: TransportState): void {
    if (next === this._state) return
    this._state = next
    for (const l of this.stateListeners) l(next)
  }
}

/** Extract a chat ID from a trouter resource path. */
function extractChatId(resource: string): string | undefined {
  // Patterns observed: /chats('19:abc@thread.v2')/messages, /chats/19:abc@thread.v2/...
  const match = resource.match(/\/chats[/(]'?([^')\/]+)'?\)?/i)
  return match?.[1]
}
