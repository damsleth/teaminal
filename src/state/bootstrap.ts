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
import { setActiveProfile, setAudiencePreference } from '../graph/client'
import { resetChatMessageTransport } from '../graph/chats'
import { getMe } from '../graph/me'
import { listActivityFeed } from '../graph/teamsActivity'
import { recordEvent, warn } from '../log'
import { drainNotifications, notifyMention } from '../notify'
import { RealtimeEventBus } from '../realtime/events'
import { setActiveTransport } from '../realtime/transport'
import { TrouterTransport } from '../realtime/trouter'
import { htmlToText } from '../text/html'
import { mergeActivityItems, countUnreadMentions } from './activityFeed'
import { startPoller, type PollerHandleRef } from './poller'
import { startRealtimeBridge } from './realtimeBridge'
import { audienceFromRouting, routingForAccount, type AppState, type Store } from './store'

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

async function hydrateActivityFeed(
  store: Store<AppState>,
  profile: string | undefined,
  isStale: () => boolean,
): Promise<void> {
  try {
    const page = await listActivityFeed({ profile, isPrefetch: true })
    // Drop the result if the session was torn down (profile switch)
    // while this detached fetch was in flight — otherwise we'd
    // repopulate the next account's wiped feed with this account's items.
    if (isStale()) return
    store.set((s) => {
      const merged = mergeActivityItems(s.activityFeed, page.items)
      return {
        activityFeed: merged,
        unreadMentionCount: countUnreadMentions(merged),
        activitySyncState: page.syncState ?? s.activitySyncState,
      }
    })
    recordEvent('app', 'info', `activity feed hydrated: ${page.items.length} items`)
  } catch (err) {
    recordEvent(
      'app',
      'warn',
      `activity feed hydrate skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function runSession(opts: RunSessionOpts): Promise<SessionHandle> {
  const { store, profile, pollerHandleRef, onFatal } = opts

  setActiveProfile(profile ?? undefined)
  // Apply this account's chat routing mode. The mode resolves to the token
  // audience the graph client mints for default calls plus whether it may
  // fall back to the other transport. A plain install (no per-account
  // preference => graph+ic3) keeps the default graph-first behavior. We also
  // clear the chatsvc message latch so a previous account's Conditional
  // Access fallback doesn't leak across a profile switch.
  {
    const settings = store.get().settings
    const account = profile ?? settings.activeAccount ?? null
    const { audience, fallback } = audienceFromRouting(routingForAccount(settings, account))
    setAudiencePreference(audience, { fallback })
    resetChatMessageTransport()
  }

  let pollerHandle: Awaited<ReturnType<typeof startPoller>> | null = null
  let bus: RealtimeEventBus | null = null
  let bridge: ReturnType<typeof startRealtimeBridge> | null = null
  let transport: TrouterTransport | null = null
  let notifyDrainTimer: ReturnType<typeof setInterval> | null = null
  // Flipped by stop(). Detached async work (e.g. the activity-feed
  // hydrate) consults this before writing to the store so a fetch that
  // resolves after a profile switch can't repopulate the next account's
  // wiped state.
  let stopped = false
  const isStale = (): boolean => stopped

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
      isStale,
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
      setActiveTransport(transport)
    } else {
      store.set({ realtimeState: 'off' })
      recordEvent('trouter', 'info', 'realtime disabled')
    }

    // Initial CSA activity feed hydrate. Best-effort: if the endpoint
    // 404s on a tenant or auth shape we haven't seen, log and continue —
    // the rest of the app doesn't depend on it.
    void hydrateActivityFeed(store, profile ?? undefined, isStale)
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
      // Signal detached async work (activity hydrate / bridge refresh) to
      // drop any store write that resolves after this point.
      stopped = true
      // Reverse-order teardown. Push side stops first so a final realtime
      // event cannot enqueue work onto a torn-down poller.
      try {
        if (notifyDrainTimer) clearInterval(notifyDrainTimer)
      } catch {}
      try {
        transport?.disconnect()
      } catch {}
      setActiveTransport(null)
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
