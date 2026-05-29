import { describe, expect, test } from 'bun:test'
import { openExternal } from './openExternal'

function recorder() {
  const calls: { cmd: string; args: string[] }[] = []
  const spawn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    return { unref() {} }
  }
  return { calls, spawn }
}

describe('openExternal', () => {
  test('uses `open` on macOS', () => {
    const r = recorder()
    expect(openExternal('https://example.com/', { platform: 'darwin', spawn: r.spawn })).toBe(true)
    expect(r.calls[0]).toEqual({ cmd: 'open', args: ['https://example.com/'] })
  })

  test('uses `xdg-open` on Linux', () => {
    const r = recorder()
    openExternal('https://example.com/', { platform: 'linux', spawn: r.spawn })
    expect(r.calls[0]).toEqual({ cmd: 'xdg-open', args: ['https://example.com/'] })
  })

  test('uses cmd start on Windows', () => {
    const r = recorder()
    openExternal('https://example.com/', { platform: 'win32', spawn: r.spawn })
    expect(r.calls[0]).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', 'https://example.com/'] })
  })

  test('refuses non-http(s)/mailto URLs without spawning', () => {
    const r = recorder()
    expect(openExternal('file:///etc/passwd', { platform: 'darwin', spawn: r.spawn })).toBe(false)
    expect(openExternal('javascript:alert(1)', { platform: 'darwin', spawn: r.spawn })).toBe(false)
    expect(r.calls).toHaveLength(0)
  })

  test('allows mailto', () => {
    const r = recorder()
    expect(openExternal('mailto:a@b.com', { platform: 'darwin', spawn: r.spawn })).toBe(true)
  })

  test('returns false (no throw) when the spawner throws', () => {
    const spawn = () => {
      throw new Error('spawn failed')
    }
    expect(openExternal('https://example.com/', { platform: 'linux', spawn })).toBe(false)
  })
})
