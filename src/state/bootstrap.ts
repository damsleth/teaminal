// Per-account session lifecycle.
//
// runSession spins up everything that depends on the active owa-piggy
// profile: getMe, capability probe, poller, realtime bridge, trouter
// transport, notification drain timer. The returned SessionHandle.stop
// tears them all down in reverse order so the next session can start
// cleanly.
//
// Account switching wires this together with resetAccountScopedState
// and setActiveProfile from src/graph/client. The CLI bootstrap calls
// runSession once at startup; the AccountsModal calls it again on
// switch via the SessionContext.

import { getToken } from '../auth/owaPiggy'
import { probeCapabilities } from '../graph/capabilities'
import { setActiveProfile } from '../graph/client'
import { getMe } from '../graph/me'
import { recordEvent, warn } from '../log'
import { drainNotifications, notifyMention } from '../notify'
import { RealtimeEventBus } from '../realtime/events'
import { TrouterTransport } from '../realtime/trouter'
import { htmlToText } from '../text/html'
import { startPoller, type PollerHandleRef } from './poller'
import { startRealtimeBridge } from './realtimeBridge'
import type { AppState, Store } from './store'

export type SessionHandle = {
  /** Profile passed to runSession; useful for logging / debugging. */
  profile: string | null
  stop: () => Promise<void>
}

export type RunSessionOpts = {
  store: Store<AppState>
  profile: string | null
  pollerHandleRef: PollerHandleRef
  /**
   * Called when bootstrap fails fatally (e.g. unauthorized /me). The
   * caller decides whether to unmount the UI and exit. Errors thrown
   * after this callback are not retried.
   */
  onFatal: (kind: 'unauthorized', message: string) => void
}

export async function runSession(opts: RunSessionOpts): Promise<SessionHandle> {
  const { store, profile, pollerHandleRef, onFatal } = opts

  setActiveProfile(profile ?? undefined)

  let pollerHandle: Awaited<ReturnType<typeof startPoller>> | null = null
  let bus: RealtimeEventBus | null = null
  let bridge: ReturnType<typeof startRealtimeBridge> | null = null
  let transport: TrouterTransport | null = null
  let notifyDrainTimer: ReturnType<typeof setInterval> | null = null

  try {
    recordEvent('app', 'info', `session starting profile=${profile ?? '(default)'}`)
    const me = await getMe()
    store.set({ me })
    recordEvent('app', 'info', 'bootstrap /me loaded')

    const capabilities = await probeCapabilities()
    store.set({ capabilities })
    recordEvent('app', 'info', 'bootstrap capability probe complete')

    if (capabilities.me.ok === false && capabilities.me.reason === 'unauthorized') {
      onFatal('unauthorized', capabilities.me.message ?? 'unauthorized')
      // The caller is expected to unmount + exit; if it returns, we still
      // want a quiet teardown rather than continuing to spin up.
      return {
        profile,
        async stop() {
          /* nothing started yet */
        },
      }
    }

    pollerHandle = startPoller({
      store,
      onError: (loop, err) => warn(`poller[${loop}]:`, err.message),
      onMention: (event) => {
        const sender = event.message.from?.user?.displayName ?? 'someone'
        const raw = event.message.body.content ?? ''
        const preview =
          event.message.body.contentType === 'text'
            ? raw.replace(/\s+/g, ' ').trim()
            : htmlToText(raw)
        const s = store.get()
        const scope = event.conv.startsWith('chat:') ? 'chat' : 'channel'
        notifyMention(
          { conv: event.conv, senderName: sender, preview: preview.slice(0, 120), scope },
          {
            now: new Date(),
            terminalFocused: s.terminalFocused !== false,
            state: { focus: s.focus, myPresence: s.myPresence, settings: s.settings },
          },
        )
      },
    })
    pollerHandleRef.current = pollerHandle
    recordEvent('poller', 'info', 'poller started')
    notifyDrainTimer = setInterval(() => drainNotifications(), 1000)

    bus = new RealtimeEventBus()
    bridge = startRealtimeBridge({
      bus,
      store,
      getPoller: () => pollerHandleRef.current,
    })

    if (store.get().settings.realtimeEnabled) {
      // Trouter / Teams authsvc requires a token with audience
      // https://api.spaces.skype.com/ - the audience the Teams desktop
      // client uses for chat / authsvc / messaging service endpoints.
      // The default Graph-audience token (graph.microsoft.com) is
      // rejected with 401 by the authsvc endpoint. owa-piggy already
      // exposes per-resource tokens via --scope, so we route the request
      // through the same scoped path the presence loop uses.
      transport = new TrouterTransport({
        bus,
        getToken: () =>
          getToken({
            profile: profile ?? undefined,
            scope: 'https://api.spaces.skype.com/.default',
          }),
        getIc3Token: () =>
          getToken({
            profile: profile ?? undefined,
            scope: 'https://ic3.teams.office.com/.default',
          }),
        profile: profile ?? undefined,
      })
      transport.onStateChange((state) => {
        store.set({
          realtimeState:
            state === 'disconnected'
              ? 'off'
              : state === 'connecting'
                ? 'connecting'
                : state === 'connected'
                  ? 'connected'
                  : state === 'reconnecting'
                    ? 'reconnecting'
                    : 'error',
        })
      })
      transport.connect().catch((err) => {
        warn('trouter: initial connect failed:', err instanceof Error ? err.message : String(err))
      })
    } else {
      store.set({ realtimeState: 'off' })
      recordEvent('trouter', 'info', 'realtime disabled')
    }
  } catch (err) {
    // Roll back partial bootstrap so the caller can retry / switch.
    try {
      transport?.disconnect()
    } catch {}
    try {
      bridge?.stop()
    } catch {}
    try {
      bus?.clear()
    } catch {}
    pollerHandleRef.current = null
    if (notifyDrainTimer) clearInterval(notifyDrainTimer)
    if (pollerHandle) await pollerHandle.stop().catch(() => {})
    throw err
  }

  return {
    profile,
    async stop() {
      recordEvent('app', 'info', `session stopping profile=${profile ?? '(default)'}`)
      // Reverse-order teardown. Push side stops first so a final realtime
      // event cannot enqueue work onto a torn-down poller.
      try {
        if (notifyDrainTimer) clearInterval(notifyDrainTimer)
      } catch {}
      try {
        transport?.disconnect()
      } catch {}
      try {
        bridge?.stop()
      } catch {}
      try {
        bus?.clear()
      } catch {}
      pollerHandleRef.current = null
      if (pollerHandle) await pollerHandle.stop().catch(() => {})
    },
  }
}
