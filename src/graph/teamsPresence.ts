// Teams unified presence client.
//
// Hits the Teams "unified presence" endpoint at presence.teams.microsoft.com,
// which returns richer information than Graph's /me/presence (availability +
// activity + deviceType + work-location + calendar OOO state) and crucially
// works under FOCI tokens whose Graph audience does not carry the
// `Presence.Read` scope.
//
// The token is acquired through owa-piggy with `--scope` set to the
// presence.teams.microsoft.com resource. owa-piggy already supports this;
// no flag changes were required there.
//
// Endpoint shape (validated 2026-05-04):
//   POST https://presence.teams.microsoft.com/v1/presence/getpresence/
//   Authorization: Bearer <aad-token, aud=https://presence.teams.microsoft.com>
//   Body: [{"mri":"8:orgid:<oid>"}, ...]
//   Response: [{ mri, presence: {...}, status }, ...]
//
// `GET /v1/users/ME/presence` does NOT work for this audience (returns
// 401 substatuscode 40102). Always go through the bulk getpresence POST,
// even for self.

import { decodeJwtClaims, getToken } from '../auth/owaPiggy'

const ENDPOINT = 'https://presence.teams.microsoft.com/v1/presence/getpresence/'
export const TEAMS_PRESENCE_SCOPE = 'https://presence.teams.microsoft.com/.default'

export class TeamsPresenceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TeamsPresenceError'
  }
}

export type TeamsPresenceEntry = {
  // Original AAD object id (the bit after "8:orgid:").
  oid: string
  availability: string
  activity: string
  deviceType?: string
  outOfOffice?: boolean
}

export type TeamsPresenceOpts = {
  profile?: string
  signal?: AbortSignal
}

type Transport = (url: string, init: RequestInit) => Promise<Response>
const realTransport: Transport = (url, init) => fetch(url, init)
let transport: Transport = realTransport

function mriFromOid(oid: string): string {
  return `8:orgid:${oid}`
}

function oidFromMri(mri: string): string {
  return mri.replace(/^8:orgid:/, '')
}

type RawPresence = {
  availability?: string
  activity?: string
  deviceType?: string
  calendarData?: { isOutOfOffice?: boolean }
}

type RawEntry = {
  mri: string
  presence?: RawPresence
  status?: number
}

async function safeText(res: Response): Promise<string> {
  try {
    const body = await res.text()
    return body.slice(0, 200)
  } catch {
    return ''
  }
}

export async function getTeamsPresenceByOid(
  oids: string[],
  opts?: TeamsPresenceOpts,
): Promise<Map<string, TeamsPresenceEntry>> {
  const out = new Map<string, TeamsPresenceEntry>()
  if (oids.length === 0) return out
  const token = await getToken({ profile: opts?.profile, scope: TEAMS_PRESENCE_SCOPE })
  const body = oids.map((oid) => ({ mri: mriFromOid(oid) }))
  const res = await transport(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: opts?.signal,
  })
  if (!res.ok) {
    throw new TeamsPresenceError(
      res.status,
      `presence.teams.microsoft.com ${res.status}: ${await safeText(res)}`,
    )
  }
  const list = (await res.json()) as RawEntry[]
  if (!Array.isArray(list)) {
    throw new TeamsPresenceError(0, 'presence.teams.microsoft.com: response was not an array')
  }
  for (const entry of list) {
    if (!entry.presence) continue
    const oid = oidFromMri(entry.mri)
    out.set(oid, {
      oid,
      availability: entry.presence.availability ?? 'PresenceUnknown',
      activity: entry.presence.activity ?? 'PresenceUnknown',
      deviceType: entry.presence.deviceType,
      outOfOffice: entry.presence.calendarData?.isOutOfOffice,
    })
  }
  return out
}

export async function getMyTeamsPresence(
  opts?: TeamsPresenceOpts,
): Promise<TeamsPresenceEntry | null> {
  const token = await getToken({ profile: opts?.profile, scope: TEAMS_PRESENCE_SCOPE })
  const claims = decodeJwtClaims(token)
  const oid = typeof claims.oid === 'string' ? claims.oid : undefined
  if (!oid) return null
  const map = await getTeamsPresenceByOid([oid], opts)
  return map.get(oid) ?? null
}

// Force the user's availability to a specific state, mimicking what
// happens when you pick "Available" from the Teams desktop status menu.
// The override expires server-side after ~5 minutes; callers that want
// it to persist must re-PUT inside that window.
//
// Endpoint shape (validated 2026-05-04):
//   PUT https://presence.teams.microsoft.com/v1/me/forceavailability/
//   Authorization: Bearer <aad-token, aud=https://presence.teams.microsoft.com>
//   Body: { "availability": "Available" }
//   Response: 200 with empty body, or 4xx with a JSON error.
//
// Same token / scope as getTeamsPresenceByOid - PresenceRW covers both
// read and write, no extra capability is needed.
export type ForceAvailabilityValue =
  | 'Available'
  | 'Busy'
  | 'Away'
  | 'DoNotDisturb'
  | 'BeRightBack'

export async function forceMyAvailability(
  availability: ForceAvailabilityValue,
  opts?: TeamsPresenceOpts,
): Promise<void> {
  const token = await getToken({ profile: opts?.profile, scope: TEAMS_PRESENCE_SCOPE })
  const url = 'https://presence.teams.microsoft.com/v1/me/forceavailability/'
  const res = await transport(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ availability }),
    signal: opts?.signal,
  })
  if (!res.ok) {
    throw new TeamsPresenceError(
      res.status,
      `presence.teams.microsoft.com/forceavailability ${res.status}: ${await safeText(res)}`,
    )
  }
}

// Test-only helpers. Underscore prefix marks them as not part of the public API.
export function __setTransportForTests(t: Transport): void {
  transport = t
}

export function __resetForTests(): void {
  transport = realTransport
}
