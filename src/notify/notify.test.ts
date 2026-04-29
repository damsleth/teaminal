import { afterEach, describe, expect, test } from 'bun:test'
import { __resetForTests, __setSpawnForTests, bell, escapeAppleScript, system } from './notify'

afterEach(() => {
  __resetForTests()
})

describe('escapeAppleScript', () => {
  test('escapes backslash and double-quote', () => {
    expect(escapeAppleScript('a"b\\c')).toBe('a\\"b\\\\c')
  })

  test('preserves single quotes (AppleScript double-quoted strings allow them)', () => {
    expect(escapeAppleScript("it's fine")).toBe("it's fine")
  })

  test('replaces newlines with the AppleScript escape', () => {
    expect(escapeAppleScript('line1\nline2')).toBe('line1\\nline2')
    expect(escapeAppleScript('line1\r\nline2')).toBe('line1\\nline2')
  })

  test('preserves unicode (non-ASCII passes through)', () => {
    expect(escapeAppleScript('hi 🎉 ✨')).toBe('hi 🎉 ✨')
    expect(escapeAppleScript('Bjørn')).toBe('Bjørn')
  })

  test('no-op for plain ASCII without specials', () => {
    expect(escapeAppleScript('hello world')).toBe('hello world')
  })
})

describe('bell', () => {
  test('writes the BEL byte to stdout', () => {
    // Hard to assert against the real stdout in this harness; instead
    // monkey-patch process.stdout.write for the duration of the test.
    const orig = process.stdout.write
    let captured = ''
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
      return true
    }) as typeof process.stdout.write
    try {
      bell()
    } finally {
      process.stdout.write = orig
    }
    expect(captured).toBe('\x07')
  })
})

describe('system on darwin', () => {
  if (process.platform !== 'darwin') {
    test('skipped on non-darwin', () => {
      expect(true).toBe(true)
    })
    return
  }

  test('spawns osascript -e with a properly escaped AppleScript line', async () => {
    let seenCmd = ''
    let seenArgs: string[] = []
    __setSpawnForTests(async (cmd, args) => {
      seenCmd = cmd
      seenArgs = args
      return { exitCode: 0 }
    })
    const result = await system('teaminal', 'Bjørn mentioned you')
    expect(result).toBe('sent')
    expect(seenCmd).toBe('osascript')
    expect(seenArgs[0]).toBe('-e')
    const script = seenArgs[1] ?? ''
    expect(script).toContain('display notification')
    expect(script).toContain('"teaminal"')
    expect(script).toContain('Bjørn mentioned you')
  })

  test('escapes embedded quotes in title and body', async () => {
    let script = ''
    __setSpawnForTests(async (_cmd, args) => {
      script = args[1] ?? ''
      return { exitCode: 0 }
    })
    await system('he said "hi"', 'use \\path')
    // " and \ inside the embedded literal are escaped
    expect(script).toContain('\\"hi\\"')
    expect(script).toContain('\\\\path')
  })

  test('returns failed when osascript exits non-zero', async () => {
    __setSpawnForTests(async () => ({ exitCode: 1 }))
    const result = await system('t', 'b')
    expect(result).toBe('failed')
  })

  test('returns failed when spawn throws (cmd not found)', async () => {
    __setSpawnForTests(async () => ({ exitCode: -1 }))
    const result = await system('t', 'b')
    expect(result).toBe('failed')
  })
})
