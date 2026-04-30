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

function cacheKey(profile?: string): string {
  return profile ?? DEFAULT_KEY
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

export async function getToken(profile?: string): Promise<string> {
  const key = cacheKey(profile)
  const now = Math.floor(Date.now() / 1000)

  const cached = cache.get(key)
  if (cached && cached.exp - now > REFRESH_MARGIN_S) {
    return cached.token
  }

  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = (async () => {
    const args = ['token', '--audience', 'graph']
    if (profile) args.push('--profile', profile)
    const { stdout, stderr, exitCode } = await runner(args)
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

export function invalidate(profile?: string): void {
  cache.delete(cacheKey(profile))
}

// Test-only helpers. Underscore prefix marks them as not part of the public API.
export function __setRunnerForTests(r: Runner): void {
  runner = r
}

export function __resetForTests(): void {
  runner = defaultRunner
  cache.clear()
  inFlight.clear()
}
