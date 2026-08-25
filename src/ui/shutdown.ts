// Clean-exit terminal restore.
//
// Ink leaves its final frame painted when it unmounts, so quitting normally
// dumps a dead copy of the UI above the shell prompt. Wipe it — but only on a
// clean, user-requested exit from a TTY. A fatal/auth error's message is the
// one thing that must survive on screen, and a piped run has no screen to
// clear.

import { freeKittyImages } from './kittyGraphics'

/**
 * Restore the terminal after a clean exit. Returns true when it actually
 * wrote something (a TTY), false otherwise.
 *
 * ponytail: not internally idempotent — the single call site in
 * bin/teaminal.tsx runs once. Add a module-level latch if a signal handler
 * ever becomes a second teardown path.
 */
export function renderCleanExit(stdout: NodeJS.WriteStream = process.stdout): boolean {
  if (!stdout.isTTY) return false
  // Kitty placements are graphics objects, not cells: a screen clear does not
  // touch them, so delete ours before wiping the text underneath. Free the
  // pixel data too — during a session it is kept deliberately so repaints can
  // re-place instead of re-transmit, but on exit it is just terminal memory.
  freeKittyImages(stdout)
  // Show cursor, reset SGR, clear the visible screen, home the cursor.
  // Deliberately no \x1b[3J — the scrollback above teaminal is the user's
  // shell history, not ours to erase.
  stdout.write('\x1b[?25h\x1b[0m\x1b[2J\x1b[H')
  return true
}
