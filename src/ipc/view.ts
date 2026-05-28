// IPC view. Thin client that mirrors the host's store and forwards
// mutations as action RPCs. Does NOT run the poller, auth refresh, or
// chatsvc — the host owns those. When the host disappears, the view
// closes itself cleanly (its only job is to be a window into the
// host's state).

import { Store, initialAppState, type AppState } from '../state/store'
import { debug, warn } from '../log'
import {
  encode,
  LineDecoder,
  PROTOCOL_VERSION,
  type ActionArgs,
  type ActionName,
  type HostToView,
  type Pane,
} from './protocol'
import { socketPath } from './socketPath'

// Store wrapper that lives inside a view process. `set()` applies the
// patch locally for immediate UI feedback AND ships it to the host as a
// `setState` RPC. The host echoes it back as a snapshot, which is a
// no-op for already-matched values (Store.set short-circuits when no
// keys actually change).
export class ViewStore extends Store<AppState> {
  constructor(
    initial: AppState,
    private dispatcher: (line: string) => void,
  ) {
    super(initial)
  }

  override set(input: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
    const partial = typeof input === 'function' ? input(this.get()) : input
    super.set(partial)
    try {
      this.dispatcher(
        encode({ type: 'action', name: 'setState', args: { partial } as ActionArgs['setState'] }),
      )
    } catch (err) {
      warn('ipc/view: setState dispatch failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // replace() is used by bootstrap on profile switch. In view mode the
  // host owns profile state, so we still mirror it locally but don't
  // dispatch — replace happens *because of* a host-sent snapshot.
  override replace(next: AppState): void {
    super.replace(next)
  }
}

export type ViewHandle = {
  store: ViewStore
  dispatch: <N extends ActionName>(name: N, args: ActionArgs[N]) => void
  stop: () => void
  // Resolves when the first snapshot lands. Lets bin/teaminal wait for
  // real state before mounting Ink, avoiding a flash of blank.
  ready: Promise<void>
  // Resolves when the host goes away. Callers use it to drive shutdown.
  closed: Promise<void>
}

export type ConnectViewOptions = {
  pane: Pane
  profile: string | null
  // How long to wait for the socket file before giving up. Defaults to
  // 2s — the layout driver launches the host first and we poll briefly
  // while it starts listening.
  connectTimeoutMs?: number
}

export async function connectView(opts: ConnectViewOptions): Promise<ViewHandle> {
  const path = socketPath(opts.profile)
  let socket: any = null
  const writeLine = (line: string): void => {
    try {
      socket?.write(line)
    } catch {
      /* peer gone */
    }
  }
  const store = new ViewStore(initialAppState(), writeLine)
  const decoder = new LineDecoder<HostToView>()

  let resolveReady: () => void
  let rejectReady: (e: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  let resolveClosed: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  let firstSnapshotSeen = false

  const connectDeadline = Date.now() + (opts.connectTimeoutMs ?? 2000)
  while (true) {
    try {
      socket = await Bun.connect({
        unix: path,
        socket: {
          open(s: any) {
            s.write(
              encode({
                type: 'hello',
                pane: opts.pane,
                profile: opts.profile,
                protocolVersion: PROTOCOL_VERSION,
              }),
            )
            debug(`ipc/view(${opts.pane}): connected to ${path}`)
          },
          data(_s: any, data: Buffer) {
            const msgs = decoder.push(data.toString('utf8'))
            for (const msg of msgs)
              handleHostMessage(msg, store, () => {
                if (!firstSnapshotSeen) {
                  firstSnapshotSeen = true
                  resolveReady()
                }
              })
          },
          close() {
            debug(`ipc/view(${opts.pane}): host closed connection`)
            resolveClosed()
          },
          error(_s: any, err: Error) {
            warn(`ipc/view(${opts.pane}): socket error:`, err.message)
            if (!firstSnapshotSeen) rejectReady(err)
            resolveClosed()
          },
        },
      })
      break
    } catch (err) {
      if (Date.now() > connectDeadline) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(
          `ipc/view(${opts.pane}): could not connect to host at ${path}: ${message}. ` +
            `Start the conversation pane first, or pass --layout=ghostty.`,
        )
      }
      // Retry briefly while the host is starting up.
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  function dispatch<N extends ActionName>(name: N, args: ActionArgs[N]): void {
    if (!socket) return
    try {
      socket.write(encode({ type: 'action', name, args }))
    } catch (err) {
      warn(`ipc/view: dispatch ${name} failed:`, err instanceof Error ? err.message : String(err))
    }
  }

  return {
    store,
    dispatch,
    ready,
    closed,
    stop() {
      try {
        socket?.end()
      } catch {
        /* already closed */
      }
    },
  }
}

function handleHostMessage(
  msg: HostToView,
  store: ViewStore,
  onSnapshot: () => void,
): void {
  if (msg.type === 'snapshot') {
    // Replace the whole state — the host is the source of truth.
    store.replace(reviveState(msg.state as AppState))
    onSnapshot()
    return
  }
  if (msg.type === 'error') {
    warn('ipc/view: host error:', msg.message)
    return
  }
  if (msg.type === 'goodbye') {
    debug(`ipc/view: host goodbye (${msg.reason})`)
    return
  }
}

// JSON.stringify turned the one Date in AppState (lastListPollAt) into
// an ISO string. Rehydrate it so the StatusBar's date-math still works.
function reviveState(raw: AppState): AppState {
  const s = raw as AppState & { lastListPollAt?: string | Date }
  if (typeof s.lastListPollAt === 'string') {
    return { ...raw, lastListPollAt: new Date(s.lastListPollAt) }
  }
  return raw
}
