// Trouter WebSocket transport for Microsoft Teams real-time events.
//
// Trouter is the internal push service used by Teams desktop/web clients.
// It delivers typing indicators, new-message signals, presence changes,
// read receipts, and more over a long-lived WebSocket.
//
// Protocol overview (reverse-engineered, not officially documented):
//   1. Exchange a Teams/Spaces access token for a Skype token via the
//      Teams auth service endpoint.
//   2. Open a Socket.IO-style WebSocket to the regional `/v4/c` endpoint.
//   3. Send `user.authenticate` over the socket with an IC3 Teams token.
//   4. Receive `trouter.connected`, then register the returned `surl`.
//   5. Trouter sends framed events. The client must respond to keepalive
//      pings and message-loss acknowledgements.
//   4. On disconnect, reconnect with exponential backoff.
//
// SECURITY: The Skype token is as sensitive as the Graph token. It is
// cached in-process only, never logged, never written to disk.

import { decodeJwtClaims } from '../auth/owaPiggy'
import { getSkypeToken } from '../graph/teamsFederation'
import { getCachedTrouterUrl } from '../graph/teamsRegion'
import { debug, recordEvent, warn } from '../log'
import type { RealtimeEventBus, RealtimeEvent } from './events'
import type {
  RealtimeTransport,
  TransportOpts,
  TransportState,
  TransportStateListener,
} from './transport'

const RECONNECT_BASE_MS = 2_000
const RECONNECT_CAP_MS = 5 * 60_000
// Trouter is undocumented and optional, but legitimate transient drops
// (Wi-Fi flap, laptop sleep, server-side restarts) are common enough
// that the previous 4-attempt cap was too aggressive — the dot turned
// red and stayed red even when a single extra retry would have
// recovered. Allow 10 attempts with a 5-min cap; if real-time push is
// gone after that, the user is likely on a flat-out broken network
// and polling-only mode is the right fallback. The user can also
// trigger a manual retry from the diagnostics modal.
const MAX_RECONNECT_ATTEMPTS = 10
const KEEPALIVE_INTERVAL_MS = 30_000

// Regional trouter URL returned by authsvc in older experiments. The
// successful Teams web trace uses the same host but connects to /v4/c,
// not /v4/a.
const TROUTER_REGISTER_URL = 'https://go.trouter.teams.microsoft.com/v4/a'
const TEAMS_REGISTRAR_URL = 'https://teams.microsoft.com/registrar/prod/V2/registrations'
const TROUTER_CLIENT_VERSION = '2026.12.01.1'

// Trouter registration responses have varied per region/version. Look
// for the WS endpoint under all known keys, including nested ones.
export function pickWsUrl(data: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    data.socketio,
    data.url,
    data.connectionUrl,
    data.endpointUrl,
    (data.connectionData as Record<string, unknown> | undefined)?.endpointUrl,
    (data.connectionData as Record<string, unknown> | undefined)?.url,
    (data.endpoint as Record<string, unknown> | undefined)?.url,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}

// Build the full trouter WebSocket URL from a registration response.
//
// Trouter exposes three URL fields per session:
//   - socketio:    `https://pub-ent-...-t.../`             (just the host root)
//   - surl:        `https://pub-ent-...-f.../v4/f/{sr}/`   (full path, port 3443)
//   - url:         `https://pub-ent-...-f.../v4/f/{sr}/`   (full path, port 8443)
// The host suffix differs (`-t` vs `-f`) and the path id is the `sr`
// value from connectparams - not the bare ccid. `surl` is the canonical
// session endpoint, so we use it verbatim and just append the SAS-style
// auth query string from connectparams.
//
// Falls back to building a path off `socketio` only when `surl`/`url`
// are absent, which we haven't seen in the wild.
export function buildTrouterWsUrl(data: Record<string, unknown>): string | null {
  const connectparams = encodeConnectParams(data.connectparams)
  const surl = typeof data.surl === 'string' ? data.surl : ''
  const url = typeof data.url === 'string' ? data.url : ''
  const fullPath = surl || url
  if (fullPath && connectparams) {
    return `${fullPath}${fullPath.includes('?') ? '&' : '?'}${connectparams}`
  }
  // Legacy / partial-response fallback: stitch a path onto socketio.
  const base = pickWsUrl(data)
  if (!base) return null
  const ccid = typeof data.ccid === 'string' ? data.ccid : ''
  if (!ccid || !connectparams) return base
  const root = base.endsWith('/') ? base : `${base}/`
  return `${root}v4/f/${encodeURIComponent(ccid)}/?${connectparams}`
}

function encodeConnectParams(raw: unknown): string {
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue
      params.append(k, String(v))
    }
    const out = params.toString()
    return out
  }
  return ''
}

// Strip the query string from a WS URL so the sensitive trouter
// session token in `?st=...` never lands in the events log. Keeps host
// + path so routing / region issues remain debuggable.
export function sanitizeWsUrlForLog(url: string): string {
  const q = url.indexOf('?')
  if (q < 0) return url
  return `${url.slice(0, q)}?<redacted>`
}

export function buildTrouterConnectUrl(
  rawTrouterUrl: string | null,
  registrationId: string,
): string {
  const base = rawTrouterUrl ?? TROUTER_REGISTER_URL
  let origin = 'https://go.trouter.teams.microsoft.com'
  try {
    origin = new URL(base).origin
  } catch {
    // keep fallback
  }
  const wsOrigin = origin.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')
  const params = new URLSearchParams({
    tc: JSON.stringify({
      cv: TROUTER_CLIENT_VERSION,
      ua: 'SkypeSpaces',
      hr: '',
      v: '0.0.0',
    }),
    timeout: '40',
    epid: registrationId,
    ccid: '',
    dom: 'teams.microsoft.com',
    cor_id: crypto.randomUUID(),
    con_num: `${Date.now()}_0`,
  })
  return `${wsOrigin}/v4/c?${params.toString()}`
}

export function parseSocketIoEvent(raw: string): SocketIoEventPacket | null {
  const match = raw.match(/^5:([^:]*?)::(\{.*\})$/)
  if (!match) return null
  const idPart = match[1] ?? ''
  const expectsAck = idPart.endsWith('+')
  const id = expectsAck ? idPart.slice(0, -1) : idPart || undefined
  try {
    const event = JSON.parse(match[2]!) as unknown
    if (!event || typeof event !== 'object') return null
    return {
      id,
      expectsAck,
      event: event as SocketIoEventPacket['event'],
    }
  } catch {
    return null
  }
}

// Decode the Graph/IC3 token's audience and scope claims so the events
// log can show *why* an upstream endpoint refused us. Never logs the
// raw token. Returns null if the token isn't decodable.
export function summariseToken(token: string): string | null {
  try {
    const claims = decodeJwtClaims(token)
    const aud = typeof claims.aud === 'string' ? claims.aud : '?'
    const scp = typeof claims.scp === 'string' ? claims.scp : ''
    const scopeBrief = scp.split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
    return `aud=${aud} scp="${scopeBrief}"`
  } catch {
    return null
  }
}

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

type TrouterConnectedPayload = {
  id?: string
  ccid?: string
  url?: string
  surl?: string
  registrarUrl?: string
  reconnectUrl?: string
  socketio?: string
  ttl?: string
  connectparams?: Record<string, unknown>
}

type SocketIoEventPacket = {
  id?: string
  expectsAck: boolean
  event: {
    name?: string
    args?: unknown[]
  }
}

export class TrouterTransport implements RealtimeTransport {
  private _state: TransportState = 'disconnected'
  private stateListeners = new Set<TransportStateListener>()
  private bus: RealtimeEventBus
  private getIc3Token: () => Promise<string>
  // Profile is needed so we can route Skype-token minting through the
  // shared per-profile cache in teamsFederation (instead of holding our
  // own copy).
  private profile: string | undefined

  private ws: WebSocket | null = null
  private skypeToken: string | null = null
  // Registration endpoint URL (POST target) returned by Teams authsvc
  // under regionGtms.trouter. Falls back to the global default when the
  // region payload is absent. Stays valid as long as the skype token
  // is fresh; cleared on token refresh.
  private trouterUrl: string | null = null
  // WebSocket URL opened for the current Socket.IO-style /v4/c session.
  private wsUrl: string | null = null
  private registrationId: string | null = null
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private disconnecting = false

  constructor(opts: TransportOpts) {
    this.bus = opts.bus
    this.getIc3Token = opts.getIc3Token ?? opts.getToken
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
      // Detach handlers before closing. close() fires onclose
      // asynchronously; if a manual retry() has already started a fresh
      // connect() by then, the stale onclose would otherwise null the
      // new socket (this.ws = null) and schedule a competing reconnect.
      const ws = this.ws
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.setState('disconnected')
  }

  // --- Auth ---

  // Delegates to the shared per-profile Skype token store in
  // teamsFederation. The store handles the authsvc round-trip, response-
  // shape variance, AAD/Skype error logging, and TTL-based caching. The
  // regional trouter URL (also surfaced by authsvc under regionGtms.trouter)
  // is read from teamsRegion's cache, which is populated as a side effect
  // of the same authsvc call.
  private async ensureSkypeToken(): Promise<void> {
    try {
      this.skypeToken = await getSkypeToken({ profile: this.profile })
    } catch (err) {
      // Mirror the per-source diagnostic event the local flow used to
      // emit so the trouter section of the events panel still surfaces
      // the failure even though the underlying request now logs under
      // the 'graph' source.
      recordEvent(
        'trouter',
        'error',
        `trouter authz delegated failure: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
    this.trouterUrl = getCachedTrouterUrl({ profile: this.profile }) ?? TROUTER_REGISTER_URL
    debug('trouter: obtained skype token via shared store')
  }

  // --- WebSocket ---

  private async openWebSocket(): Promise<void> {
    this.registrationId = crypto.randomUUID()
    const ic3Token = await this.getIc3Token()
    const tokenSummary = summariseToken(ic3Token)
    if (tokenSummary) recordEvent('trouter', 'debug', `trouter ic3 token ${tokenSummary}`)
    this.wsUrl = buildTrouterConnectUrl(this.trouterUrl, this.registrationId)

    const sanitized = sanitizeWsUrlForLog(this.wsUrl)
    recordEvent('trouter', 'debug', `trouter ws connecting ${sanitized}`)

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl!)
      let settled = false

      const timeout = setTimeout(() => {
        if (!settled) {
          try {
            ws.close()
          } catch {}
          reject(new Error('trouter: websocket authentication timeout'))
        }
      }, 15_000)

      ws.onopen = () => {
        debug('trouter: websocket upgrade complete')
        this.ws = ws
        this.startKeepalive()
      }

      ws.onmessage = (event) => {
        void this.handleSocketMessage(String(event.data), ic3Token)
          .then((connected) => {
            if (!connected || settled) return
            settled = true
            clearTimeout(timeout)
            this.reconnectAttempts = 0
            this.setState('connected')
            resolve()
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err)
            debug('trouter: frame handling error:', message)
            if (!settled) {
              settled = true
              clearTimeout(timeout)
              try {
                ws.close()
              } catch {}
              reject(err instanceof Error ? err : new Error(message))
            }
          })
      }

      ws.onerror = (event) => {
        const msg = (event as ErrorEvent).message ?? 'unknown'
        warn('trouter: websocket error:', msg)
        recordEvent('trouter', 'error', `trouter ws error ${msg}`)
      }

      ws.onclose = (event) => {
        clearTimeout(timeout)
        const closeEvent = event as CloseEvent
        const code = typeof closeEvent.code === 'number' ? closeEvent.code : 0
        const reason = typeof closeEvent.reason === 'string' ? closeEvent.reason : ''
        debug('trouter: websocket closed', code, reason)
        recordEvent(
          'trouter',
          'warn',
          `trouter ws closed code=${code}${reason ? ` reason=${reason.slice(0, 200)}` : ''}`,
        )
        this.ws = null
        this.clearKeepalive()
        if (!settled) {
          settled = true
          reject(new Error(`trouter: websocket closed before registration code=${code}`))
          return
        }
        if (!this.disconnecting) {
          this.scheduleReconnect()
        }
      }
    })
  }

  private async handleSocketMessage(raw: string, ic3Token: string): Promise<boolean> {
    if (raw === '1::') {
      this.sendSocketEvent('user.authenticate', [
        {
          headers: {
            Authorization: `Bearer ${ic3Token}`,
            'X-MS-Migration': 'True',
          },
        },
      ])
      recordEvent('trouter', 'debug', 'trouter ws authenticated')
      return false
    }

    if (raw === '2::') {
      this.ws?.send('2::')
      return false
    }

    const packet = parseSocketIoEvent(raw)
    if (packet) {
      const name = packet.event.name ?? ''
      const firstArg = packet.event.args?.[0]
      if (name === 'trouter.connected' && firstArg && typeof firstArg === 'object') {
        const connected = firstArg as TrouterConnectedPayload
        recordEvent(
          'trouter',
          'debug',
          `trouter connected id=${connected.id ? `${connected.id.slice(0, 12)}...` : 'missing'} registrar=${connected.registrarUrl ? 'yes' : 'no'}`,
        )
        await this.registerRegistrar(connected)
        return true
      }

      if (name === 'trouter.message_loss') {
        if (packet.id && firstArg !== undefined) {
          this.sendSocketEvent('trouter.processed_message_loss', [firstArg], `${packet.id}+`)
        }
        return false
      }

      if (firstArg && typeof firstArg === 'object') {
        for (const event of this.mapToRealtimeEvents(firstArg as TrouterEventBody)) {
          this.bus.emit(event)
        }
      }
      return false
    }

    const frame = this.parseFrame(raw)
    this.handleFrame(frame)
    return false
  }

  private sendSocketEvent(name: string, args: unknown[], id = ''): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(`5:${id}::${JSON.stringify({ name, args })}`)
  }

  private async registerRegistrar(connected: TrouterConnectedPayload): Promise<void> {
    const path = connected.surl ?? connected.url
    if (!path) throw new Error('trouter.connected missing surl/url')
    const registrationId = this.registrationId
    if (!registrationId) throw new Error('missing trouter registrationId')

    const body = {
      clientDescription: {
        appId: 'SkypeSpacesWeb',
        aesKey: '',
        languageId: 'en-US',
        platform: 'edgeChromium',
        templateKey: 'SkypeSpacesWeb_2.6',
        platformUIVersion: '0.0.0',
      },
      registrationId,
      nodeId: '',
      transports: {
        TROUTER: [{ context: '', path, ttl: 3600 }],
      },
    }

    const res = await fetch(TEAMS_REGISTRAR_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/javascript',
        'content-type': 'application/json',
        origin: 'https://teams.microsoft.com',
        referer: 'https://teams.microsoft.com/v2/',
        ...(this.skypeToken ? { 'x-skypetoken': this.skypeToken } : {}),
        'x-ms-migration': 'True',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      recordEvent(
        'trouter',
        'error',
        `trouter registrar ${res.status} ${res.statusText || ''} body=${text.slice(0, 200).replace(/\s+/g, ' ')}`,
      )
      throw new Error(`Trouter registrar ${res.status}: ${text.slice(0, 200)}`)
    }
    recordEvent('trouter', 'debug', `trouter registrar ${res.status}`)
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
        this.ws.send('2::')
      } catch {
        // swallow
      }
    }
  }

  // --- Reconnect ---

  // Manual retry trigger: surface from the diagnostics modal so a user
  // who sees the red push-state dot can recover without restarting the
  // app. Idempotent — safe to call whether the transport is currently
  // connected, error'd, or already retrying.
  retry(): void {
    recordEvent('trouter', 'info', 'trouter: manual retry requested')
    this.reconnectAttempts = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // disconnect() flips state to 'disconnected' but is idempotent if we
    // already are; then we kick off a fresh connect cycle.
    this.disconnect()
    void this.connect()
  }

  private scheduleReconnect(): void {
    if (this.disconnecting) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      warn('trouter: max reconnect attempts reached, giving up')
      recordEvent(
        'trouter',
        'warn',
        'realtime offline — falling back to polling. Trigger a retry from diagnostics.',
      )
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
