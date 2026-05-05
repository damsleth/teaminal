// Shared types for keybind handlers.
//
// Each zone (list / chat / filter) exposes a handler that takes the raw
// Ink useInput payload plus a per-zone context bag. Handlers return
// 'handled' when they consumed the keystroke, or 'pass' when the App's
// fallback (Esc / Tab / refresh / ?) should run.
//
// Keeping handlers as pure-ish functions makes them unit-testable in
// isolation and shrinks the giant useInput closure in App.tsx into a
// thin dispatcher.

import type { Key } from 'ink'

export type KeyResult = 'handled' | 'pass'

export type RawKey = {
  input: string
  key: Key
}
