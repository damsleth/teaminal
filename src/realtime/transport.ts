// Abstract interface for real-time push transports.
//
// Transports connect to a push source (trouter WebSocket, SSE, etc.) and
// emit RealtimeEvents onto the event bus. The poller and store subscribe
// to the bus — they never import a specific transport directly.
//
// Lifecycle:
//   1. Caller creates a transport and passes it the event bus.
//   2. connect() initiates the push connection.
//   3. Events flow through the bus until disconnect() or an error.
//   4. On error the transport enters 'reconnecting' and retries with
//      exponential backoff. After maxReconnectAttempts it moves to 'error'.
//   5. disconnect() is idempotent and cancels pending reconnects.

import type { RealtimeEventBus } from './events'

export type TransportState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export type TransportStateListener = (state: TransportState) => void

export interface RealtimeTransport {
  readonly state: TransportState
  connect(): Promise<void>
  disconnect(): void
  onStateChange(listener: TransportStateListener): () => void
}

export type TransportOpts = {
  bus: RealtimeEventBus
  /** Function that returns a fresh Skype/Spaces access token. */
  getToken: () => Promise<string>
  /** Function that returns a fresh IC3 Teams access token for websocket auth. */
  getIc3Token?: () => Promise<string>
  /** owa-piggy profile alias, if any. */
  profile?: string
}
