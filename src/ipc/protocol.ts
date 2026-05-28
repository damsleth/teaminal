// Wire protocol for the host/view socket.
//
// One JSON object per line. The host owns the store + poller + auth and
// broadcasts snapshots; view processes connect, receive snapshots, and
// send action RPCs back. v1 sends full snapshots on every change (not
// JSON-patch) — simpler to get right, can optimise later if the
// firehose hurts.

import type { AppState } from '../state/store'

export const PROTOCOL_VERSION = 1

export type Pane = 'list' | 'conversation' | 'status' | 'composer'

// Messages sent from view to host.
export type ViewToHost =
  | { type: 'hello'; pane: Pane; profile: string | null; protocolVersion: number }
  | { type: 'ack'; seq: number }
  | { type: 'action'; name: ActionName; args: unknown }

// Messages sent from host to view.
export type HostToView =
  | { type: 'snapshot'; seq: number; state: unknown }
  | { type: 'error'; message: string }
  | { type: 'goodbye'; reason: string }

// Whitelisted action names. Views can only invoke these RPCs; everything
// else is rejected by the host. Two kinds:
//   - setState: generic partial-state merge. Views use this for all
//     pure-state mutations (focus, cursor, draft text, etc.). The view
//     evaluates updater fns locally and ships the resulting partial.
//   - server actions: side effects that need network/chatsvc access
//     and only make sense on the host (submitMessage, refresh).
export const ACTION_NAMES = ['setState', 'submitMessage', 'refresh', 'hardRefresh'] as const
export type ActionName = (typeof ACTION_NAMES)[number]

export type ActionArgs = {
  setState: { partial: Partial<AppState> }
  submitMessage:
    | { kind: 'chat'; chatId: string; text: string }
    | { kind: 'channel'; teamId: string; channelId: string; text: string }
    | { kind: 'reply'; teamId: string; channelId: string; rootId: string; text: string }
  refresh: Record<string, never>
  hardRefresh: Record<string, never>
}

export function isActionName(s: string): s is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(s)
}

export function encode(msg: ViewToHost | HostToView): string {
  return JSON.stringify(msg) + '\n'
}

// Stateful line splitter for socket data. Returns parsed messages and
// retains any trailing partial line for the next chunk.
export class LineDecoder<T> {
  private buf = ''
  push(chunk: string): T[] {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    const out: T[] = []
    for (const line of lines) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // Malformed line — drop. The peer is on the wrong protocol.
      }
    }
    return out
  }
}
