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

import { graph, GraphError } from './client'

export type CapabilityArea = 'me' | 'chats' | 'joinedTeams' | 'presence'

export type CapabilityFailureReason =
  | 'unauthorized'
  | 'unavailable'
  | 'transient'
  | 'unknown'

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
  if (err instanceof GraphError) {
    if (err.status === 401) {
      return { ok: false, reason: 'unauthorized', status: 401, message: err.message }
    }
    if (err.status === 403) {
      return { ok: false, reason: 'unavailable', status: 403, message: err.message }
    }
    if (err.status === 429) {
      return { ok: false, reason: 'transient', status: 429, message: err.message }
    }
    return { ok: false, reason: 'unknown', status: err.status, message: err.message }
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
    runProbe(() =>
      graph({
        method: 'GET',
        path: '/me/presence',
        signal,
      }),
    ),
  ])

  return { me, chats, joinedTeams, presence }
}
