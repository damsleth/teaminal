import { describe, expect, it } from 'bun:test'
import { openSystemEmojiPicker } from './emojiPicker'

type Call = { file: string; args: string[] }

function recordingExec() {
  const calls: Call[] = []
  const exec = (file: string, args: string[], cb: (err: Error | null) => void) => {
    calls.push({ file, args })
    cb(null)
  }
  return { calls, exec }
}

describe('openSystemEmojiPicker', () => {
  it('synthesises the ⌃⌘Space keystroke via osascript on macOS', () => {
    const { calls, exec } = recordingExec()
    openSystemEmojiPicker({ platform: 'darwin', exec })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toBe('osascript')
    expect(calls[0]!.args[0]).toBe('-e')
    // key code 49 is Space; control+command opens the Character Viewer.
    expect(calls[0]!.args[1]).toContain('key code 49 using {control down, command down}')
  })

  it('is a no-op on non-macOS platforms', () => {
    const { calls, exec } = recordingExec()
    openSystemEmojiPicker({ platform: 'linux', exec })
    expect(calls).toHaveLength(0)
  })
})
