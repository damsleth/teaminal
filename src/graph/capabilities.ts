// First-run capability probe.
//
// Runs the four endpoints teaminal depends on in parallel and classifies
// each into ok / unauthorized / unavailable / transient / unknown. The
// caller decides how to degrade (e.g. hide the Teams pane on
// joinedTeams unavailable, disable other-user presence on presence
// unavailable, surface a single auth-broken banner if /me itself fails).
//
// All probes are non-mutating GETs - we never POST a test message to
// verify send permissions.

import { getActiveProfile, graph, GraphError } from './client'
import { getMyTeamsPresence, TeamsPresenceError } from './teamsPresence'

export type CapabilityArea = 'me' | 'chats' | 'joinedTeams' | 'presence'

export type CapabilityFailureReason = 'unauthorized' | 'unavailable' | 'transient' | 'unknown'

export type CapabilityResult =
  | { ok: true }
  | {
      ok: false
      reason: CapabilityFailureReason
      status?: number
      message: string
    }

export type Capabilities = Record<CapabilityArea, CapabilityResult>

export type ProbeOpts = {
  signal?: AbortSignal
}

function classify(err: unknown): CapabilityResult {
  if (err instanceof GraphError || err instanceof TeamsPresenceError) {
    if (err.status === 401) {
      return { ok: false, reason: 'unauthorized', status: 401, message: err.message }
    }
    if (err.status === 403) {
      return { ok: false, reason: 'unavailable', status: 403, message: err.message }
    }
    if (err.status === 404) {
      return { ok: false, reason: 'unavailable', status: 404, message: err.message }
    }
    if (err.status === 429) {
      return { ok: false, reason: 'transient', status: 429, message: err.message }
    }
    return {
      ok: false,
      reason: 'unknown',
      status: err.status === 0 ? undefined : err.status,
      message: err.message,
    }
  }
  if (err instanceof Error) {
    return { ok: false, reason: 'unknown', message: err.message }
  }
  return { ok: false, reason: 'unknown', message: String(err) }
}

async function runProbe(fn: () => Promise<unknown>): Promise<CapabilityResult> {
  try {
    await fn()
    return { ok: true }
  } catch (err) {
    return classify(err)
  }
}

export async function probeCapabilities(opts?: ProbeOpts): Promise<Capabilities> {
  const signal = opts?.signal
  const [me, chats, joinedTeams, presence] = await Promise.all([
    runProbe(() =>
      graph({
        method: 'GET',
        path: '/me',
        query: { $select: 'id,displayName' },
        signal,
      }),
    ),
    runProbe(() =>
      graph({
        method: 'GET',
        path: '/chats',
        query: { $top: 1, $expand: 'lastMessagePreview' },
        signal,
      }),
    ),
    runProbe(() =>
      // /me/joinedTeams does not accept $top or $select under delegated auth -
      // any unsupported query parameter returns 400 ("Query option ... is not
      // allowed"). The probe pays the small cost of fetching the full list.
      graph({
        method: 'GET',
        path: '/me/joinedTeams',
        signal,
      }),
    ),
    // Presence probes the Teams unified presence endpoint
    // (presence.teams.microsoft.com) rather than Graph /me/presence.
    // Under FOCI the broker token has aud=presence.teams.microsoft.com
    // and scp=PresenceRW, but typically lacks Presence.Read on the
    // Graph audience, so /me/presence 403s in tenants where the Teams
    // path works fine. The runtime poller already uses the Teams
    // transport; the probe matches it so Diagnostics reflects reality.
    runProbe(async () => {
      const result = await getMyTeamsPresence({ profile: getActiveProfile(), signal })
      if (!result) {
        throw new TeamsPresenceError(
          0,
          'presence.teams.microsoft.com: token had no oid claim',
        )
      }
      return result
    }),
  ])

  return { me, chats, joinedTeams, presence }
}
