// Per-account session lifecycle.
//
// runSession spins up everything that depends on the active owa-piggy
// profile: getMe, capability probe, poller, realtime bridge, trouter
// transport, notification drain timer. The returned SessionHandle.stop
// tears them all down in reverse order so the next session can start
// cleanly.
//
// Account switching wires this together with resetAccountScopedState.
// Every Graph call the session makes runs on its own bound client
// (SessionHandle.client); there is no process-wide active profile. The CLI
// bootstrap calls
// runSession once at startup; the AccountsModal calls it again on
// switch via the SessionContext.

import { accountRef, type AccountRef } from '../account'
import { getToken } from '../auth/owaPiggy'
import { probeCapabilities } from '../graph/capabilities'
import { createGraphClient, setAudiencePreference, type GraphClient } from '../graph/client'
import { resetChatMessageTransport } from '../graph/chats'
import { getMe } from '../graph/me'
import { listActivityFeed } from '../graph/teamsActivity'
import { recordEvent, warn } from '../log'
import { drainNotifications, notifyMention } from '../notify'
import { RealtimeEventBus } from '../realtime/events'
import { getActiveTransport, setActiveTransport } from '../realtime/transport'
import { TrouterTransport } from '../realtime/trouter'
import { htmlToText } from '../text/html'
import { mergeActivityItems, countUnreadMentions, recordNotification } from './activityFeed'
import { startPoller, type PollerHandleRef } from './poller'
import { accountStore, type AccountStore } from './accountStore'
import { startRealtimeBridge } from './realtimeBridge'
import { chatLabel } from './selectables'
import {
  audienceFromRouting,
  focusKey,
  routingForAccount,
  type AppState,
  type ChatRoutingMode,
  type Store,
} from './store'

// Apply an account's chat routing mode and clear its chatsvc message latch,
// so a graph-401 fallback taken under the old mode doesn't outlive the change.
// ponytail: M1 keeps the audience in one process-wide preference that every
// session client reads; per-account routing state arrives with the store split.
export function applyChatRouting(account: AccountRef, mode: ChatRoutingMode): void {
  const { audience, fallback } = audienceFromRouting(mode)
  setAudiencePreference(audience, { fallback })
  resetChatMessageTransport(account)
}

export type SessionHandle = {
  /** Profile passed to runSession; useful for logging / debugging. */
  profile: string | null
  /** Graph client bound to this session's account. */
  client: () => GraphClient
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

async function hydrateActivityFeed(store: AccountStore, isStale: () => boolean): Promise<void> {
  try {
    const page = await listActivityFeed({ account: store.ref, isPrefetch: true })
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
  const { profile, pollerHandleRef, onFatal } = opts
  const sessionAccount = accountRef(profile)
  // Everything this session writes goes through a handle bound to the
  // store's current (account, generation); the caller resets the store for
  // this account before starting the session.
  const store = accountStore(opts.store)
  if (store.ref.id !== sessionAccount.id) {
    throw new Error('runSession: store is bound to another account')
  }
  // Every Graph call this session makes runs as sessionAccount, with the
  // audience of *this* account's routing (not the process-wide preference,
  // which another session could set). Read per call so a routing change in
  // the Accounts modal applies to the next request.
  const routingKey = profile ?? store.get().settings.activeAccount ?? null
  const client = (): GraphClient =>
    createGraphClient({
      account: sessionAccount,
      ...audienceFromRouting(routingForAccount(store.get().settings, routingKey)),
    })

  // Apply this account's chat routing mode. The mode resolves to the token
  // audience the graph client mints for default calls plus whether it may
  // fall back to the other transport. A plain install (no per-account
  // preference => graph+ic3) keeps the default graph-first behavior. We also
  // clear the chatsvc message latch so a previous account's Conditional
  // Access fallback doesn't leak across a profile switch.
  applyChatRouting(sessionAccount, routingForAccount(store.get().settings, routingKey))

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
  const isStale = (): boolean => stopped || !store.isCurrent()

  try {
    recordEvent('app', 'info', `session starting profile=${profile ?? '(default)'}`)
    const me = await getMe(client())
    store.set({ me })
    recordEvent('app', 'info', 'bootstrap /me loaded')

    const capabilities = await probeCapabilities(client())
    store.set({ capabilities })
    recordEvent('app', 'info', 'bootstrap capability probe complete')

    if (capabilities.me.ok === false && capabilities.me.reason === 'unauthorized') {
      onFatal('unauthorized', capabilities.me.message ?? 'unauthorized')
      // The caller is expected to unmount + exit; if it returns, we still
      // want a quiet teardown rather than continuing to spin up.
      return {
        profile,
        client,
        async stop() {
          /* nothing started yet */
        },
      }
    }

    pollerHandle = startPoller({
      store,
      getClient: client,
      onError: (loop, err) => warn(`poller[${loop}]:`, err.message),
      onMention: (event) => {
        const sender = event.message.from?.user?.displayName ?? 'someone'
        const raw = event.message.body.content ?? ''
        const preview =
          event.message.body.contentType === 'text'
            ? raw.replace(/\s+/g, ' ').trim()
            : htmlToText(raw)
        const s = store.get()
        const chatId = event.conv.startsWith('chat:') ? event.conv.slice('chat:'.length) : null
        const chat = chatId ? s.chats.find((c) => c.id === chatId) : undefined
        const scope = chat
          ? chatLabel(chat, s.me?.id, { nameByUserId: s.nameByUserId })
          : chatId
            ? 'chat'
            : 'channel'
        const viewing = focusKey(s.focus) === event.conv && s.terminalFocused !== false
        // Plain messages in the chat you're reading: no bell, no record.
        // Mentions keep their bell-only path (decideQuiet).
        if (viewing && event.kind === 'message') return
        if (!viewing) {
          recordNotification(store, {
            kind: event.kind,
            chatId: chatId ?? undefined,
            messageId: event.message.id,
            senderId: event.message.from?.user?.id,
            senderDisplayName: sender,
            preview: preview.slice(0, 200),
            createdAt: event.message.createdDateTime,
          })
        }
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
        // A late state from a pending connect/reconnect must not land in
        // the next account's store after a switch.
        if (isStale()) return
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
    void hydrateActivityFeed(store, isStale)
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
    client,
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
      // Only clear the slot if it is still ours.
      if (transport && getActiveTransport() === transport) setActiveTransport(null)
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
