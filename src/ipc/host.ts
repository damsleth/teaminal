// IPC host. Owns the store + poller + auth (all already in this
// process — we only add the socket here). Accepts view connections,
// broadcasts the full store state on every change, and applies
// whitelisted action RPCs back into the store.

import { unlinkSync } from 'node:fs'
import { postChannelReply, sendChannelMessage, sendChatMessage } from '../state/chatActions'
import type { Store, AppState } from '../state/store'
import type { PollerHandleRef } from '../state/poller'
import { debug, warn } from '../log'
import {
  encode,
  isActionName,
  LineDecoder,
  PROTOCOL_VERSION,
  type ActionArgs,
  type ActionName,
  type HostToView,
  type ViewToHost,
} from './protocol'
import { socketPath } from './socketPath'

export type HostHandle = {
  socket: string
  stop: () => void
}

type Conn = {
  write: (s: string) => void
  end: () => void
  decoder: LineDecoder<ViewToHost>
}

export type StartHostOptions = {
  store: Store<AppState>
  profile: string | null
  pollerRef: PollerHandleRef
}

export async function startHost(opts: StartHostOptions): Promise<HostHandle> {
  const path = socketPath(opts.profile)
  // Stale socket from a previous host that didn't clean up. Bun.listen
  // would EADDRINUSE otherwise.
  try {
    unlinkSync(path)
  } catch {
    // ENOENT is fine.
  }

  const conns = new Map<unknown, Conn>()
  let seq = 0

  function snapshotLine(): string {
    seq++
    return encode({ type: 'snapshot', seq, state: opts.store.get() })
  }

  function broadcast(): void {
    const line = snapshotLine()
    for (const c of conns.values()) c.write(line)
  }

  // Coalesce broadcast triggers within a single frame. Presence /
  // typing / read-receipt updates can fire several store mutations per
  // 16ms; without this, four view panes each parse + re-render every
  // intermediate state. With it, they see the settled state once.
  let coalesceHandle: ReturnType<typeof setTimeout> | null = null
  function scheduleBroadcast(): void {
    if (coalesceHandle !== null) return
    coalesceHandle = setTimeout(() => {
      coalesceHandle = null
      broadcast()
    }, 16)
  }

  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket: any) {
        const conn: Conn = {
          write: (s) => {
            try {
              socket.write(s)
            } catch {
              /* peer gone */
            }
          },
          end: () => {
            try {
              socket.end()
            } catch {
              /* already closed */
            }
          },
          decoder: new LineDecoder<ViewToHost>(),
        }
        conns.set(socket, conn)
        debug(`ipc/host: connection opened, total=${conns.size}`)
        conn.write(snapshotLine())
      },
      data(socket: any, data: Buffer) {
        const conn = conns.get(socket)
        if (!conn) return
        const msgs = conn.decoder.push(data.toString('utf8'))
        for (const msg of msgs) handleViewMessage(msg, conn, opts)
      },
      close(socket: any) {
        conns.delete(socket)
        debug(`ipc/host: connection closed, total=${conns.size}`)
      },
      error(_socket: any, err: Error) {
        warn('ipc/host: socket error:', err.message)
      },
    },
  })

  const unsubscribe = opts.store.subscribe(() => scheduleBroadcast())

  return {
    socket: path,
    stop() {
      unsubscribe()
      if (coalesceHandle !== null) {
        clearTimeout(coalesceHandle)
        coalesceHandle = null
      }
      for (const c of conns.values()) {
        c.write(encode({ type: 'goodbye', reason: 'host-shutdown' } satisfies HostToView))
        c.end()
      }
      conns.clear()
      try {
        server.stop(true)
      } catch {
        /* already stopped */
      }
      try {
        unlinkSync(path)
      } catch {
        /* nothing to clean */
      }
    },
  }
}

function handleViewMessage(msg: ViewToHost, conn: Conn, opts: StartHostOptions): void {
  if (msg.type === 'hello') {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      conn.write(
        encode({
          type: 'error',
          message: `protocol version mismatch: host=${PROTOCOL_VERSION} view=${msg.protocolVersion}`,
        } satisfies HostToView),
      )
      conn.end()
    }
    return
  }
  if (msg.type === 'ack') return
  if (msg.type === 'action') {
    if (!isActionName(msg.name)) {
      conn.write(encode({ type: 'error', message: `unknown action: ${String(msg.name)}` }))
      return
    }
    void runAction(msg.name, msg.args, opts).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      warn(`ipc/host: action ${msg.name} failed:`, message)
      conn.write(encode({ type: 'error', message: `action ${msg.name} failed: ${message}` }))
    })
  }
}

async function runAction<N extends ActionName>(
  name: N,
  rawArgs: unknown,
  opts: StartHostOptions,
): Promise<void> {
  const args = rawArgs as ActionArgs[N]
  switch (name) {
    case 'setState': {
      const { partial } = args as ActionArgs['setState']
      // Trust the view: it only sends keys we own (state mirror). Any
      // bad data here would have failed JSON.parse already.
      opts.store.set(partial)
      return
    }
    case 'submitMessage': {
      const a = args as ActionArgs['submitMessage']
      if (a.kind === 'chat') await sendChatMessage(a.chatId, a.text)
      else if (a.kind === 'channel') await sendChannelMessage(a.teamId, a.channelId, a.text)
      else if (a.kind === 'reply')
        await postChannelReply(a.teamId, a.channelId, a.rootId, a.text)
      opts.pollerRef.current?.refresh()
      return
    }
    case 'refresh':
      opts.pollerRef.current?.refresh()
      return
    case 'hardRefresh':
      opts.pollerRef.current?.hardRefresh?.()
      return
  }
}
