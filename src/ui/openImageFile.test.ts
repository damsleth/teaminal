import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { cleanupImageTempFiles, materializeImage, openImageFile } from './openImageFile'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
])

describe('materializeImage', () => {
  test('writes the blob to a private file named from the cache key, not the sender', () => {
    const path = materializeImage('19:abc@thread.v2/../../etc/passwd', PNG)
    expect(path).not.toBeNull()
    // Sender-controlled text must never reach the path.
    expect(path).not.toContain('passwd')
    expect(path).not.toContain('..')
    expect(path!.endsWith('.png')).toBe(true)
    expect(readFileSync(path!)).toEqual(PNG)
    // Owner-only.
    expect(statSync(path!).mode & 0o777).toBe(0o600)
    cleanupImageTempFiles()
    expect(existsSync(path!)).toBe(false)
  })

  test('the same cache key is stable across calls', () => {
    const a = materializeImage('k', PNG)
    const b = materializeImage('k', PNG)
    expect(a).toBe(b)
    cleanupImageTempFiles()
  })
})

describe('openImageFile', () => {
  test('opens a path inside the session directory', () => {
    const path = materializeImage('k', PNG)!
    const calls: string[][] = []
    const ok = openImageFile(path, {
      platform: 'darwin',
      spawn: (cmd, args) => {
        calls.push([cmd, ...args])
        return { unref: () => {} }
      },
    })
    expect(ok).toBe(true)
    expect(calls).toEqual([['open', path]])
    cleanupImageTempFiles()
  })

  test('refuses a path outside the session directory', () => {
    materializeImage('k', PNG) // establish the session dir
    const calls: string[][] = []
    const ok = openImageFile('/etc/passwd', {
      platform: 'darwin',
      spawn: (cmd, args) => {
        calls.push([cmd, ...args])
        return { unref: () => {} }
      },
    })
    expect(ok).toBe(false)
    expect(calls).toEqual([])
    cleanupImageTempFiles()
  })

  test('cleanup is idempotent', () => {
    cleanupImageTempFiles()
    cleanupImageTempFiles()
  })
})
