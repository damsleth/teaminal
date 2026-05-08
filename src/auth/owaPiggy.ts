// Subprocess wrapper around `owa-piggy token`.
//
// Contract:
//   - never invokes `--json` (would leak the rotated refresh token from FOCI exchange)
//   - default-mode stdout is the raw access token; stderr carries setup/reseed hints verbatim
//   - in-process cache avoids subprocess spawn cost on the 5s active poll
//   - single-flight per cache key dedupes concurrent re-spawns when multiple
//     pollers race a 401 simultaneously

const REFRESH_MARGIN_S = 60
const DEFAULT_KEY = '<owa-default>'

export class OwaPiggyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwaPiggyError'
  }
}

type RunResult = { stdout: string; stderr: string; exitCode: number }
type Runner = (args: string[]) => Promise<RunResult>

const defaultRunner: Runner = async (args) => {
  const proc = Bun.spawn(['owa-piggy', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

let runner: Runner = defaultRunner

type CacheEntry = { token: string; exp: number }
const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<string>>()
// Tenants without preauthorization between the Teams Web app id and a
// specific Graph scope (e.g. ChannelMessage.Read.All) reject the FOCI
// exchange with AADSTS65002. We retry once without --scope and remember
// the failure so subsequent calls skip the explicit scope entirely.
const scopeFallbacks = new Set<string>()

const DEFAULT_SCOPE_KEY = '<graph-default>'

export type GetTokenOpts = {
  profile?: string
  // Pass-through to owa-piggy's --scope flag. Lets callers ask for a token
  // with a non-default audience (e.g. Teams unified presence) without
  // adding a new flag to owa-piggy. Cached separately from the default
  // graph token, so concurrent loops with different scopes don't fight
  // each other in the in-process cache.
  scope?: string
}

function normalizeOpts(opts?: GetTokenOpts | string): GetTokenOpts {
  if (opts === undefined) return {}
  if (typeof opts === 'string') return { profile: opts }
  return opts
}

function fullCacheKey(opts: GetTokenOpts): string {
  return `${opts.profile ?? DEFAULT_KEY}::${opts.scope ?? DEFAULT_SCOPE_KEY}`
}

function scopeFallbackCacheKey(opts: GetTokenOpts): string {
  return `${opts.profile ?? DEFAULT_KEY}::${opts.scope ?? DEFAULT_SCOPE_KEY}`
}

function isPreauthFailure(stderr: string): boolean {
  // AADSTS65002: Teams Web app id has no preauthorization for the
  // requested Graph scope in this tenant. Fall back to the default
  // graph audience token.
  return /AADSTS65002/i.test(stderr)
}

// AAD codes that mean "the refresh token is gone - the user must
// re-authenticate this profile". 700084 is the SPA 24h hard expiry,
// 700082 is generic refresh-token expired, 50173/50158/50076 are
// re-auth required (password change, MFA gate, etc.).
const REFRESH_EXPIRED_CODES = /AADSTS(700084|700082|50173|50158|50076|54005)/i

export function isRefreshExpiredError(message: string | undefined | null): boolean {
  if (!message) return false
  return REFRESH_EXPIRED_CODES.test(message) || /invalid_grant/i.test(message)
}

export type ReseedOpts = {
  profile?: string
}

export async function reseed(opts?: ReseedOpts): Promise<void> {
  const args = ['reseed']
  if (opts?.profile) args.push('--profile', opts.profile)
  const { stderr, exitCode } = await runner(args)
  if (exitCode !== 0) {
    throw new OwaPiggyError(stderr.trim() || `owa-piggy reseed exited with code ${exitCode}`)
  }
  // Reseed rotates the refresh + access tokens; clear cached tokens
  // and the per-scope failure set so the next getToken re-spawns
  // against a fresh refresh token.
  for (const key of Array.from(cache.keys())) {
    if (!opts?.profile || key.startsWith(`${opts.profile}::`)) cache.delete(key)
  }
  scopeFallbacks.clear()
}

export type OwaPiggyProfileStatus = {
  profile: string
  valid: boolean
  accessTokenExpiresAt?: string
  refreshTokenExpiresAt?: string
  audience?: string
  scopes?: string[]
  scopeSummary?: string
  error?: string
}

export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new OwaPiggyError('malformed token: expected 3 dot-separated parts')
  }
  const payloadB64 = parts[1]
  if (!payloadB64) {
    throw new OwaPiggyError('malformed token: empty payload segment')
  }
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'))
  } catch {
    throw new OwaPiggyError('malformed token: payload is not valid JSON')
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new OwaPiggyError('malformed token: payload is not an object')
  }
  return payload as Record<string, unknown>
}

export function decodeJwtExp(token: string): number {
  const claims = decodeJwtClaims(token)
  const exp = claims.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new OwaPiggyError('malformed token: missing or non-numeric exp')
  }
  return exp
}

export async function getToken(opts?: GetTokenOpts | string): Promise<string> {
  const normalized = normalizeOpts(opts)
  const key = fullCacheKey(normalized)
  const now = Math.floor(Date.now() / 1000)

  const cached = cache.get(key)
  if (cached && cached.exp - now > REFRESH_MARGIN_S) {
    return cached.token
  }

  const existing = inFlight.get(key)
  if (existing) return existing

  const scopeFallbackKey = scopeFallbackCacheKey(normalized)
  const useScope = normalized.scope && !scopeFallbacks.has(scopeFallbackKey)

  const promise = (async () => {
    const runOnce = async (
      withScope: boolean,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const args = ['token']
      if (withScope && normalized.scope) {
        args.push('--scope', normalized.scope)
      } else {
        args.push('--audience', 'graph')
      }
      if (normalized.profile) args.push('--profile', normalized.profile)
      return runner(args)
    }

    let { stdout, stderr, exitCode } = await runOnce(!!useScope)
    if (exitCode !== 0 && useScope && isPreauthFailure(stderr)) {
      scopeFallbacks.add(scopeFallbackKey)
      ;({ stdout, stderr, exitCode } = await runOnce(false))
    }
    if (exitCode !== 0) {
      const msg = stderr.trim() || `owa-piggy exited with code ${exitCode}`
      throw new OwaPiggyError(msg)
    }
    const token = stdout.trim()
    if (!token) {
      throw new OwaPiggyError('owa-piggy returned empty stdout (expected access token)')
    }
    const exp = decodeJwtExp(token)
    cache.set(key, { token, exp })
    return token
  })()

  inFlight.set(key, promise)
  try {
    return await promise
  } finally {
    inFlight.delete(key)
  }
}

export function invalidate(opts?: GetTokenOpts | string): void {
  cache.delete(fullCacheKey(normalizeOpts(opts)))
}

function splitStatusBlocks(stdout: string, fallbackProfile?: string): string[][] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  const blocks: string[][] = []
  let current: string[] = []
  const isHeader = (line: string): boolean =>
    /^\[profile=[^\]]+\]$/.test(line) || /^profile:\s+\S+$/.test(line)
  for (const line of lines) {
    if (isHeader(line) && current.length > 0) {
      blocks.push(current)
      current = [line]
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current)
  if (blocks.length === 1 && !isHeader(blocks[0]?.[0] ?? '') && fallbackProfile) {
    blocks[0]?.unshift(`[profile=${fallbackProfile}]`)
  }
  return blocks
}

function parseProfileBlock(lines: string[], index: number): OwaPiggyProfileStatus | null {
  const first = lines[0] ?? ''
  const bracketLabel = first.match(/^\[profile=([^\]]+)\]$/)
  const colonLabel = first.match(/^profile:\s+(\S+)$/)
  const label = bracketLabel ?? colonLabel
  const profile = label?.[1] ?? (index === 0 ? DEFAULT_KEY : `profile-${index + 1}`)
  const body = label ? lines.slice(1) : lines
  if (body.length === 0) return null

  const out: OwaPiggyProfileStatus = {
    profile,
    valid: false,
  }
  for (const line of body) {
    const trimmed = line.trim()
    if (trimmed === 'no valid token') {
      out.valid = false
      continue
    }
    const access = trimmed.match(/^authtoken:\s+expires\s+(.+)$/)
    if (access) {
      out.valid = true
      out.accessTokenExpiresAt = access[1]
      continue
    }
    const audience = trimmed.match(/^audience:\s+(.+)$/)
    if (audience) {
      out.audience = audience[1]
      continue
    }
    const scopes = trimmed.match(/^scope\(s\):\s+(.+)$/)
    if (scopes) {
      const scopeSummary = scopes[1] ?? ''
      out.scopeSummary = scopeSummary
      out.scopes = scopeSummary
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0 && !scope.startsWith('...'))
      continue
    }
    const refresh = trimmed.match(/^refreshtoken:\s+expires\s+(.+)$/)
    if (refresh) {
      out.refreshTokenExpiresAt = refresh[1]
      continue
    }
    const err = trimmed.match(/^ERROR:\s+(.+)$/)
    if (err) {
      out.error = err[1]
    }
  }
  return out
}

export function parseStatusProfiles(
  stdout: string,
  fallbackProfile?: string,
): OwaPiggyProfileStatus[] {
  return splitStatusBlocks(stdout, fallbackProfile)
    .map((block, index) => parseProfileBlock(block, index))
    .filter((profile): profile is OwaPiggyProfileStatus => profile !== null)
}

export type ListProfilesFromStatusOpts = {
  profile?: string
}

export async function listProfilesFromStatus(
  opts?: ListProfilesFromStatusOpts,
): Promise<OwaPiggyProfileStatus[]> {
  const args = ['status', '--audience', 'graph']
  if (opts?.profile) args.push('--profile', opts.profile)
  const { stdout, stderr, exitCode } = await runner(args)
  const profiles = parseStatusProfiles(stdout, opts?.profile)
  if (profiles.length > 0) return profiles
  if (exitCode !== 0) {
    const msg = stderr.trim() || `owa-piggy status exited with code ${exitCode}`
    throw new OwaPiggyError(msg)
  }
  return profiles
}

// Test-only helpers. Underscore prefix marks them as not part of the public API.
export function __setRunnerForTests(r: Runner): void {
  runner = r
}

export function __resetForTests(): void {
  runner = defaultRunner
  cache.clear()
  inFlight.clear()
  scopeFallbacks.clear()
}
