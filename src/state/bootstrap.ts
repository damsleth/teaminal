// Per-account session lifecycle.
//
// runSession spins up everything that depends on one owa-piggy profile:
// getMe, capability probe, poller, realtime bridge, trouter transport. The
// returned SessionHandle.stop tears them all down in reverse order.
//
// A session owns its poller and transport (on the handle) and writes only
// through the AccountStore it is given, so two sessions can run in one
// process. Every Graph call it makes runs on its own bound client
// (SessionHandle.client). The AccountManager opens the account slot, starts
// the session and decides which session's poller the UI sees.

import { accountRef, type AccountRef } from '../account'
import { getToken, isRefreshExpiredError } from '../auth/owaPiggy'
import { probeCapabilities } from '../graph/capabilities'
import { createGraphClient, type GraphClient } from '../graph/client'
import { resetChatMessageTransport } from '../graph/chats'
import { getMe } from '../graph/me'
import { listActivityFeed } from '../graph/teamsActivity'
import { recordEvent, warn } from '../log'
import { notifyMention } from '../notify'
import { RealtimeEventBus } from '../realtime/events'
import type { RealtimeTransport, TransportOpts } from '../realtime/transport'
import { TrouterTransport } from '../realtime/trouter'
import { htmlToText } from '../text/html'
import { mergeActivityItems, countUnreadMentions, recordNotification } from './activityFeed'
import { startPoller, type PollerHandle } from './poller'
import type { AccountStore } from './accountStore'
import { startRealtimeBridge } from './realtimeBridge'
import { chatLabel } from './selectables'
import { audienceFromRouting, routingForAccount } from './store'
import { visibleConvKeys } from './panes'

// Clear an account's chatsvc message latch after its chat routing mode
// changed, so a graph-401 fallback taken under the old mode doesn't outlive
// the change. The session client reads the mode itself on every call.
export function applyChatRouting(account: AccountRef): void {
  resetChatMessageTransport(account)
}

export type SessionHandle = {
  /** Profile passed to runSession; useful for logging / debugging. */
  profile: string | null
  /** Graph client bound to this session's account. */
  client: () => GraphClient
  /** This session's poller; null when bootstrap stopped before starting it. */
  poller: PollerHandle | null
  /** This session's push transport; null when realtime is off. */
  transport: RealtimeTransport | null
  stop: () => Promise<void>
}

export type RunSessionOpts = {
  // The open account slot this session writes to. Writes drop once the
  // slot is closed or re-opened.
  account: AccountStore
  profile: string | null
  // Test seam: the push transport (realtimeEnabled only).
  createTransport?: (opts: TransportOpts) => RealtimeTransport
  /**
   * Called when bootstrap fails fatally (e.g. unauthorized /me). The
   * caller decides whether to unmount the UI and exit. Errors thrown
   * after this callback are not retried.
   */
  onFatal: (kind: 'unauthorized', message: string) => void
  // Concurrent mode: a loop reported a refresh-token expiry. The caller
  // stops the session and keeps the account's slot (conn authError).
  onAuthExpired?: (err: Error) => void
  // Concurrent mode: true while more than one account runs, so
  // notifications name the account.
  labelled?: () => boolean
  // Concurrent mode: the chat-list filter from the root store.
  listFilter?: () => string
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
  const { account: store, profile, onFatal } = opts
  const sessionAccount = accountRef(profile)
  if (store.ref.id !== sessionAccount.id) {
    throw new Error('runSession: store is bound to another account')
  }
  // Every Graph call this session makes runs as sessionAccount, with the
  // audience of *this* account's routing. Read per call so a routing change
  // in the Accounts modal applies to the next request. The default profile
  // has no routing entry of its own (DEFAULT_CHAT_ROUTING).
  const client = (): GraphClient =>
    createGraphClient({
      account: sessionAccount,
      ...audienceFromRouting(routingForAccount(store.get().settings, profile)),
    })

  // Clear the chatsvc message latch so a previous run's Conditional Access
  // fallback for this account doesn't outlive a restart of its session.
  applyChatRouting(sessionAccount)

  let pollerHandle: PollerHandle | null = null
  let bus: RealtimeEventBus | null = null
  let bridge: ReturnType<typeof startRealtimeBridge> | null = null
  let transport: RealtimeTransport | null = null
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
        poller: null,
        transport: null,
        async stop() {
          /* nothing started yet */
        },
      }
    }

    pollerHandle = startPoller({
      store,
      getClient: client,
      listFilter: opts.listFilter,
      onError: (loop, err) => {
        warn(`poller[${store.ref.label}:${loop}]:`, err.message)
        // Presence runs on its own scoped tokens; a challenge on one of
        // those (MFA for one resource) must not stop the whole account.
        if (opts.onAuthExpired && loop !== 'presence' && isRefreshExpiredError(err.message)) {
          opts.onAuthExpired(err)
        }
      },
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
        // On screen: the active pane, or the passive pane while it is shown.
        const visibleConvs = visibleConvKeys(s)
        const viewing = visibleConvs.includes(event.conv) && s.terminalFocused !== false
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
          {
            conv: event.conv,
            senderName: sender,
            preview: preview.slice(0, 120),
            scope,
            account: { id: store.ref.id, label: store.ref.label },
            labelled: opts.labelled?.() ?? false,
          },
          {
            now: new Date(),
            terminalFocused: s.terminalFocused !== false,
            visibleConvs,
            state: { focus: s.focus, myPresence: s.myPresence, settings: s.settings },
          },
        )
      },
    })
    recordEvent('poller', 'info', 'poller started')

    bus = new RealtimeEventBus()
    bridge = startRealtimeBridge({
      bus,
      store,
      getPoller: () => pollerHandle,
    })

    if (store.get().settings.realtimeEnabled) {
      // Trouter / Teams authsvc requires a token with audience
      // https://api.spaces.skype.com/ - the audience the Teams desktop
      // client uses for chat / authsvc / messaging service endpoints.
      // The default Graph-audience token (graph.microsoft.com) is
      // rejected with 401 by the authsvc endpoint. owa-piggy already
      // exposes per-resource tokens via --scope, so we route the request
      // through the same scoped path the presence loop uses.
      const createTransport = opts.createTransport ?? ((o) => new TrouterTransport(o))
      transport = createTransport({
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
    if (pollerHandle) await pollerHandle.stop().catch(() => {})
    throw err
  }

  return {
    profile,
    client,
    poller: pollerHandle,
    transport,
    async stop() {
      recordEvent('app', 'info', `session stopping profile=${profile ?? '(default)'}`)
      // Signal detached async work (activity hydrate / bridge refresh) to
      // drop any store write that resolves after this point.
      stopped = true
      // Reverse-order teardown. Push side stops first so a final realtime
      // event cannot enqueue work onto a torn-down poller.
      try {
        transport?.disconnect()
      } catch {}
      try {
        bridge?.stop()
      } catch {}
      try {
        bus?.clear()
      } catch {}
      if (pollerHandle) await pollerHandle.stop().catch(() => {})
    },
  }
}
