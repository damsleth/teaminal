// Per-profile region resolution for Teams chatsvc / federation / search.
//
// Tenants are provisioned in one of Teams' regional clusters: `emea`,
// `amer`, `apac`, `ind`, etc. Calls to /api/chatsvc/{region}/...,
// /api/mt/part/{region}/..., and similar paths must use the right
// short region prefix or the request 404s immediately.
//
// The canonical source is the `regionGtms` map returned by
// `POST https://teams.microsoft.com/api/authsvc/v1.0/authz`. Each
// value is a regional host like `https://emea.ng.msg.teams.microsoft.com`,
// from which the short region is the first path component of the
// hostname.
//
// We hook the existing `getSkypeToken` call (which already does the
// authz POST) and ask it to surface `regionGtms` so we don't issue a
// duplicate authsvc round-trip. `resolveRegion` triggers a single
// `getSkypeToken` call per profile if the cache is cold, and returns
// `emea` as a last-resort default only on hard failure so the rest of
// the app degrades gracefully instead of crashing on a non-emea tenant.

import { recordEvent } from '../log'
import { getActiveProfile } from './client'
import { getSkypeToken } from './teamsFederation'

export const FALLBACK_REGION = 'emea'
export const TEAMS_ORIGIN = 'https://teams.microsoft.com'

export type RegionResolveOpts = {
  profile?: string
  signal?: AbortSignal
}

// Per-profile Teams service endpoints, derived from the authz response's
// `region`/`partition` fields and the `regionGtms` map. teaminal builds
// most URLs as `teams.microsoft.com/api/{svc}/{region}/...`, but the
// middle-tier path uses the partition segment (e.g. `emea-02`), which we
// pull from `regionGtms.middleTier`.
export type TeamsEndpoints = {
  // Short region for chatsvc / csa / ups path segments (e.g. 'emea').
  region: string
  // Partition path segment for /api/mt/part/{partition} (e.g. 'emea-02').
  partition: string
}

const regionCache = new Map<string, string>()
const partitionCache = new Map<string, string>()
// Trouter registration URL is also derived from the authsvc response
// (under `regionGtms.trouter`). Cache it alongside the region so the
// trouter transport doesn't have to issue a parallel authsvc call.
const trouterUrlCache = new Map<string, string>()

function cacheKey(opts?: RegionResolveOpts): string {
  return opts?.profile ?? getActiveProfile() ?? '<default>'
}

// Parse `https://emea.ng.msg.teams.microsoft.com[/...]` → `"emea"`.
// Returns null when the host doesn't match (e.g. IP, missing dot,
// `teams.microsoft.com` itself).
export function regionFromHost(host: string | undefined | null): string | null {
  if (!host || typeof host !== 'string') return null
  const match = host.match(/^https?:\/\/([a-z0-9-]+)\.[a-z0-9-]+\./i)
  if (!match) return null
  const candidate = match[1]!.toLowerCase()
  // Filter obvious non-regions: `go`, `www`, `teams`, etc. arrive via
  // regionGtms.trouter (the trouter host has no region prefix). Real
  // region tokens are 3-4 alpha chars.
  if (/^[a-z]{3,4}$/.test(candidate)) return candidate
  return null
}

// Extract the short region from a parsed `regionGtms` block. Tries the
// service entries most likely to carry the user's tenant region first
// (chatService is the canonical one in HARs we've inspected). Returns
// null if none of the entries yield a parseable region.
export function pickRegionFromGtms(
  regionGtms: Record<string, unknown> | null | undefined,
): string | null {
  if (!regionGtms || typeof regionGtms !== 'object') return null
  const candidates = [
    'chatService',
    'middleTier',
    'presenceService',
    'userProfileService',
    'authService',
  ]
  for (const key of candidates) {
    const value = regionGtms[key]
    const region = typeof value === 'string' ? regionFromHost(value) : null
    if (region) return region
  }
  // Fallback: any value in the block.
  for (const value of Object.values(regionGtms)) {
    const region = typeof value === 'string' ? regionFromHost(value) : null
    if (region) return region
  }
  return null
}

// Pull the partition path segment from the middleTier URL, e.g.
// `https://teams.microsoft.com/api/mt/part/emea-02` → `emea-02`. The
// top-level `partition` field (`emea02`) lacks the dash the path needs,
// so the URL is the reliable source.
export function partitionFromMiddleTier(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null
  const m = url.match(/\/api\/mt\/part\/([a-z0-9-]+)/i)
  return m ? m[1]!.toLowerCase() : null
}

// Populate the cache from authsvc data. Called by getSkypeToken when
// it sees a fresh authsvc response.
export function ingestAuthzData(profile: string | undefined, data: unknown): void {
  if (!data || typeof data !== 'object') return
  const obj = data as Record<string, unknown>
  const regionGtms = obj.regionGtms as Record<string, unknown> | undefined
  const key = profile ?? '<default>'
  const region = pickRegionFromGtms(regionGtms)
  if (region) {
    const prev = regionCache.get(key)
    regionCache.set(key, region)
    if (prev !== region) {
      recordEvent('graph', 'info', `teams region resolved to "${region}" for profile ${key}`)
    }
  }
  const partition = partitionFromMiddleTier(
    regionGtms && typeof regionGtms.middleTier === 'string' ? regionGtms.middleTier : undefined,
  )
  if (partition) partitionCache.set(key, partition)
  const trouterUrl =
    regionGtms && typeof regionGtms.trouter === 'string' ? regionGtms.trouter : undefined
  if (trouterUrl) trouterUrlCache.set(key, trouterUrl)
}

export function getCachedRegion(opts?: RegionResolveOpts): string | undefined {
  return regionCache.get(cacheKey(opts))
}

export function getCachedTrouterUrl(opts?: RegionResolveOpts): string | undefined {
  return trouterUrlCache.get(cacheKey(opts))
}

// Resolves the region for the given profile, triggering an authsvc
// round-trip via getSkypeToken if the cache is cold. Returns
// FALLBACK_REGION on hard failure.
export async function resolveRegion(opts?: RegionResolveOpts): Promise<string> {
  const key = cacheKey(opts)
  const cached = regionCache.get(key)
  if (cached) return cached
  try {
    // getSkypeToken's authsvc call will side-effect into the cache via
    // ingestAuthzData. Don't care about the token itself here.
    await getSkypeToken({ profile: opts?.profile, signal: opts?.signal })
  } catch (err) {
    recordEvent(
      'graph',
      'warn',
      `teams region resolve failed, defaulting to ${FALLBACK_REGION}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return FALLBACK_REGION
  }
  return regionCache.get(key) ?? FALLBACK_REGION
}

// Default partition path when authz didn't surface a middleTier URL.
// The mt path generally mirrors the region with a `-01` partition suffix;
// `emea` → `emea-01`. This is only a last resort — the real value comes
// from regionGtms.middleTier.
function defaultPartition(region: string): string {
  return `${region}-01`
}

export function getCachedEndpoints(opts?: RegionResolveOpts): TeamsEndpoints | undefined {
  const key = cacheKey(opts)
  const region = regionCache.get(key)
  if (!region) return undefined
  return {
    region,
    partition: partitionCache.get(key) ?? defaultPartition(region),
  }
}

// Resolve the full Teams endpoint set for a profile, triggering an authsvc
// round-trip (via getSkypeToken) if the cache is cold. Falls back to the
// default region/partition on hard failure.
export async function resolveEndpoints(opts?: RegionResolveOpts): Promise<TeamsEndpoints> {
  const region = await resolveRegion(opts)
  const key = cacheKey(opts)
  return {
    region,
    partition: partitionCache.get(key) ?? defaultPartition(region),
  }
}

export function __resetForTests(): void {
  regionCache.clear()
  partitionCache.clear()
  trouterUrlCache.clear()
}

export function __setRegionForTests(profile: string | undefined, region: string): void {
  regionCache.set(profile ?? '<default>', region)
}

export function __setPartitionForTests(profile: string | undefined, partition: string): void {
  partitionCache.set(profile ?? '<default>', partition)
}
