import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests,
  __setRunnerForTests,
  decodeJwtClaims,
  decodeJwtExp,
  getToken,
  invalidate,
  listProfilesFromStatus,
  OwaPiggyError,
  parseStatusProfiles,
} from './owaPiggy'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600

afterEach(() => {
  __resetForTests()
})

describe('decodeJwtExp', () => {
  test('returns numeric exp from a valid JWT payload', () => {
    const jwt = makeJwt({ exp: 1735689600, sub: 'user' })
    expect(decodeJwtExp(jwt)).toBe(1735689600)
  })

  test('throws when the token has the wrong number of parts', () => {
    expect(() => decodeJwtExp('only.two')).toThrow(OwaPiggyError)
    expect(() => decodeJwtExp('a.b.c.d')).toThrow(OwaPiggyError)
  })

  test('throws when the payload segment is empty', () => {
    expect(() => decodeJwtExp('header..sig')).toThrow(/empty payload/)
  })

  test('throws when payload is not valid JSON', () => {
    const bogus = `header.${Buffer.from('not json').toString('base64url')}.sig`
    expect(() => decodeJwtExp(bogus)).toThrow(/not valid JSON/)
  })

  test('throws when payload has no exp', () => {
    const jwt = makeJwt({ sub: 'user' })
    expect(() => decodeJwtExp(jwt)).toThrow(/missing or non-numeric exp/)
  })

  test('throws when exp is not a number', () => {
    const jwt = makeJwt({ exp: 'soon' })
    expect(() => decodeJwtExp(jwt)).toThrow(/missing or non-numeric exp/)
  })
})

describe('decodeJwtClaims', () => {
  test('returns the payload object verbatim', () => {
    const jwt = makeJwt({
      exp: FAR_FUTURE,
      tid: '11111111-2222-3333-4444-555555555555',
      scp: 'Chat.Read Channel.ReadBasic.All',
      upn: 'a@b.com',
    })
    const claims = decodeJwtClaims(jwt)
    expect(claims.tid).toBe('11111111-2222-3333-4444-555555555555')
    expect(claims.scp).toBe('Chat.Read Channel.ReadBasic.All')
    expect(claims.upn).toBe('a@b.com')
  })

  test('throws on a malformed token', () => {
    expect(() => decodeJwtClaims('only.two')).toThrow(OwaPiggyError)
  })
})

describe('getToken caching', () => {
  test('caches the token across calls within the same profile', async () => {
    const token = makeJwt({ exp: FAR_FUTURE })
    let calls = 0
    __setRunnerForTests(async () => {
      calls++
      return { stdout: token, stderr: '', exitCode: 0 }
    })

    const a = await getToken()
    const b = await getToken()
    expect(a).toBe(token)
    expect(b).toBe(token)
    expect(calls).toBe(1)
  })

  test('different profiles cache independently', async () => {
    const tokenA = makeJwt({ exp: FAR_FUTURE, sub: 'a' })
    const tokenB = makeJwt({ exp: FAR_FUTURE, sub: 'b' })
    __setRunnerForTests(async (args) => {
      const profileIdx = args.indexOf('--profile')
      const profile = profileIdx >= 0 ? args[profileIdx + 1] : null
      return {
        stdout: profile === 'work' ? tokenA : tokenB,
        stderr: '',
        exitCode: 0,
      }
    })

    const work = await getToken('work')
    const home = await getToken('home')
    expect(work).toBe(tokenA)
    expect(home).toBe(tokenB)
    expect(work).not.toBe(home)
  })

  test('refreshes when the cached token is within the 60s margin', async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 30
    const stale = makeJwt({ exp: nearExpiry })
    const fresh = makeJwt({ exp: FAR_FUTURE })
    const stdouts = [stale, fresh]
    let calls = 0
    __setRunnerForTests(async () => {
      const out = stdouts[calls++]
      return { stdout: out ?? fresh, stderr: '', exitCode: 0 }
    })

    expect(await getToken()).toBe(stale)
    expect(await getToken()).toBe(fresh)
    expect(calls).toBe(2)
  })

  test('passes --profile through to the runner', async () => {
    const token = makeJwt({ exp: FAR_FUTURE })
    let seenArgs: string[] = []
    __setRunnerForTests(async (args) => {
      seenArgs = args
      return { stdout: token, stderr: '', exitCode: 0 }
    })

    await getToken('work')
    expect(seenArgs).toEqual(['token', '--audience', 'graph', '--profile', 'work'])
  })

  test('omits --profile when none is supplied', async () => {
    const token = makeJwt({ exp: FAR_FUTURE })
    let seenArgs: string[] = []
    __setRunnerForTests(async (args) => {
      seenArgs = args
      return { stdout: token, stderr: '', exitCode: 0 }
    })

    await getToken()
    expect(seenArgs).toEqual(['token', '--audience', 'graph'])
  })
})

describe('getToken single-flight', () => {
  test('concurrent calls dedupe to a single subprocess spawn', async () => {
    const token = makeJwt({ exp: FAR_FUTURE })
    let calls = 0
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    __setRunnerForTests(async () => {
      calls++
      await gate
      return { stdout: token, stderr: '', exitCode: 0 }
    })

    const pending = Promise.all([getToken(), getToken(), getToken()])
    expect(calls).toBe(1)
    release!()
    const results = await pending
    expect(results).toEqual([token, token, token])
    expect(calls).toBe(1)
  })

  test('different profiles do not block each other under concurrency', async () => {
    const tokenA = makeJwt({ exp: FAR_FUTURE, sub: 'a' })
    const tokenB = makeJwt({ exp: FAR_FUTURE, sub: 'b' })
    let calls = 0
    __setRunnerForTests(async (args) => {
      calls++
      const profileIdx = args.indexOf('--profile')
      const profile = profileIdx >= 0 ? args[profileIdx + 1] : null
      return {
        stdout: profile === 'work' ? tokenA : tokenB,
        stderr: '',
        exitCode: 0,
      }
    })

    const [a, b] = await Promise.all([getToken('work'), getToken('home')])
    expect(a).toBe(tokenA)
    expect(b).toBe(tokenB)
    expect(calls).toBe(2)
  })
})

describe('getToken errors', () => {
  test('throws OwaPiggyError preserving stderr verbatim on non-zero exit', async () => {
    const stderr =
      "OWA_REFRESH_TOKEN not set for profile 'work'. Run: owa-piggy setup --profile work"
    __setRunnerForTests(async () => ({ stdout: '', stderr, exitCode: 1 }))

    await expect(getToken('work')).rejects.toBeInstanceOf(OwaPiggyError)
    await expect(getToken('work')).rejects.toThrow(stderr)
  })

  test('throws when stdout is empty even on exit code 0', async () => {
    __setRunnerForTests(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    await expect(getToken()).rejects.toThrow(/empty stdout/)
  })

  test('falls back to a generic message when stderr is empty on failure', async () => {
    __setRunnerForTests(async () => ({ stdout: '', stderr: '', exitCode: 42 }))
    await expect(getToken()).rejects.toThrow(/exited with code 42/)
  })

  test('errors do not poison the cache', async () => {
    const token = makeJwt({ exp: FAR_FUTURE })
    let calls = 0
    __setRunnerForTests(async () => {
      calls++
      if (calls === 1) return { stdout: '', stderr: 'transient', exitCode: 1 }
      return { stdout: token, stderr: '', exitCode: 0 }
    })

    await expect(getToken()).rejects.toThrow('transient')
    expect(await getToken()).toBe(token)
    expect(calls).toBe(2)
  })
})

describe('invalidate', () => {
  test('clears the cached token so the next call respawns', async () => {
    const tokenA = makeJwt({ exp: FAR_FUTURE, jti: 'a' })
    const tokenB = makeJwt({ exp: FAR_FUTURE, jti: 'b' })
    const stdouts = [tokenA, tokenB]
    let calls = 0
    __setRunnerForTests(async () => {
      const out = stdouts[calls++]
      return { stdout: out ?? tokenB, stderr: '', exitCode: 0 }
    })

    expect(await getToken()).toBe(tokenA)
    expect(await getToken()).toBe(tokenA) // still cached
    invalidate()
    expect(await getToken()).toBe(tokenB)
    expect(calls).toBe(2)
  })

  test('invalidating one profile leaves others cached', async () => {
    const tokenWork = makeJwt({ exp: FAR_FUTURE, sub: 'w' })
    const tokenHome = makeJwt({ exp: FAR_FUTURE, sub: 'h' })
    let calls = 0
    __setRunnerForTests(async (args) => {
      calls++
      const profile = args[args.indexOf('--profile') + 1]
      return {
        stdout: profile === 'work' ? tokenWork : tokenHome,
        stderr: '',
        exitCode: 0,
      }
    })

    await getToken('work')
    await getToken('home')
    expect(calls).toBe(2)

    invalidate('work')
    await getToken('work') // re-spawn
    await getToken('home') // still cached
    expect(calls).toBe(3)
  })
})

describe('parseStatusProfiles', () => {
  test('parses a single-profile status stdout using the fallback profile name', () => {
    const profiles = parseStatusProfiles(
      [
        'authtoken:    expires 2026-04-30T11:46:51Z',
        'audience:     graph (00000003-0000-0000-c000-000000000000)',
        'scope(s):     Chat.Read, Chat.ReadWrite, User.Read',
        'refreshtoken: expires 2026-05-01T09:30:00Z',
      ].join('\n'),
      'work',
    )
    expect(profiles).toEqual([
      {
        profile: 'work',
        valid: true,
        accessTokenExpiresAt: '2026-04-30T11:46:51Z',
        audience: 'graph (00000003-0000-0000-c000-000000000000)',
        scopeSummary: 'Chat.Read, Chat.ReadWrite, User.Read',
        scopes: ['Chat.Read', 'Chat.ReadWrite', 'User.Read'],
        refreshTokenExpiresAt: '2026-05-01T09:30:00Z',
      },
    ])
  })

  test('parses multi-profile status stdout with valid and invalid profiles', () => {
    const profiles = parseStatusProfiles(
      [
        '[profile=work]',
        'authtoken:    expires 2026-04-30T11:46:51Z',
        'audience:     graph (00000003-0000-0000-c000-000000000000)',
        'scope(s):     Calendars.ReadWrite, Mail.ReadWrite, Files.ReadWrite, ... (74 scopes)',
        'refreshtoken: expires unknown (run `owa-piggy reseed` to establish)',
        '',
        '[profile=personal]',
        'no valid token',
        'ERROR: AADSTS700084: refresh token expired',
      ].join('\n'),
    )
    expect(profiles).toHaveLength(2)
    expect(profiles[0]).toMatchObject({
      profile: 'work',
      valid: true,
      accessTokenExpiresAt: '2026-04-30T11:46:51Z',
      refreshTokenExpiresAt: 'unknown (run `owa-piggy reseed` to establish)',
    })
    expect(profiles[0]?.scopes).toEqual([
      'Calendars.ReadWrite',
      'Mail.ReadWrite',
      'Files.ReadWrite',
    ])
    expect(profiles[1]).toMatchObject({
      profile: 'personal',
      valid: false,
      error: 'AADSTS700084: refresh token expired',
    })
  })

  test('returns an empty array for empty stdout', () => {
    expect(parseStatusProfiles('')).toEqual([])
  })
})

describe('listProfilesFromStatus', () => {
  test('runs owa-piggy status with graph audience and parses stdout', async () => {
    let seenArgs: string[] = []
    __setRunnerForTests(async (args) => {
      seenArgs = args
      return {
        stdout: [
          '[profile=work]',
          'authtoken:    expires 2026-04-30T11:46:51Z',
          'audience:     graph (00000003-0000-0000-c000-000000000000)',
          'scope(s):     Chat.Read',
          'refreshtoken: expires 2026-05-01T09:30:00Z',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }
    })
    const profiles = await listProfilesFromStatus()
    expect(seenArgs).toEqual(['status', '--audience', 'graph'])
    expect(seenArgs).not.toContain('--json')
    expect(profiles.map((x) => x.profile)).toEqual(['work'])
    expect(profiles[0]?.valid).toBe(true)
  })

  test('passes --profile for single-profile status', async () => {
    let seenArgs: string[] = []
    __setRunnerForTests(async (args) => {
      seenArgs = args
      return {
        stdout: [
          'authtoken:    expires 2026-04-30T11:46:51Z',
          'audience:     graph (00000003-0000-0000-c000-000000000000)',
          'scope(s):     Chat.Read',
          'refreshtoken: expires 2026-05-01T09:30:00Z',
        ].join('\n'),
        stderr: '[profile=work]',
        exitCode: 0,
      }
    })
    const profiles = await listProfilesFromStatus({ profile: 'work' })
    expect(seenArgs).toEqual(['status', '--audience', 'graph', '--profile', 'work'])
    expect(profiles[0]?.profile).toBe('work')
  })

  test('returns parsed invalid profiles even when owa-piggy exits non-zero', async () => {
    __setRunnerForTests(async () => ({
      stdout: ['[profile=expired]', 'no valid token'].join('\n'),
      stderr: '',
      exitCode: 1,
    }))
    const profiles = await listProfilesFromStatus()
    expect(profiles).toEqual([{ profile: 'expired', valid: false }])
  })

  test('throws with stderr when status exits non-zero without parseable stdout', async () => {
    __setRunnerForTests(async () => ({
      stdout: '',
      stderr: 'no profiles configured. Run: owa-piggy setup --profile <alias>',
      exitCode: 1,
    }))
    await expect(listProfilesFromStatus()).rejects.toThrow(/no profiles configured/)
  })
})
