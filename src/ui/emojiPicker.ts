// Pops the macOS system emoji & symbols picker (the Character Viewer) by
// synthesising the ⌃⌘Space shortcut through System Events. The picker inserts
// the chosen glyph as input into the focused terminal, where the reaction
// capture overlay reads it off stdin and sends it to Graph as the reaction —
// which is exactly the unicode glyph the Graph setReaction API wants.
//
// macOS-only; a no-op elsewhere. Requires the terminal to hold Accessibility +
// Automation permission (the first call surfaces the system prompt). Any
// failure (denied permission, osascript missing) is logged and swallowed — the
// user can still open the picker manually with ⌃⌘Space, which lands in the
// same capture overlay.

import { execFile } from 'node:child_process'
import { recordEvent } from '../log'

const KEYSTROKE_SCRIPT =
  'tell application "System Events" to key code 49 using {control down, command down}'

export type OpenEmojiPickerDeps = {
  platform?: NodeJS.Platform
  // Injected in tests so the real keystroke is never synthesised; production
  // shells out to osascript.
  exec?: (file: string, args: string[], cb: (err: Error | null) => void) => void
}

export function openSystemEmojiPicker(deps: OpenEmojiPickerDeps = {}): void {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') return
  const exec = deps.exec ?? ((file, args, cb) => execFile(file, args, (err) => cb(err)))
  exec('osascript', ['-e', KEYSTROKE_SCRIPT], (err) => {
    if (err) recordEvent('ui', 'warn', `emoji picker open failed: ${err.message}`)
  })
}
