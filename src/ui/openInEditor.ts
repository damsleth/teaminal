// Open a config file in $VISUAL (falling back to $EDITOR) from inside the
// running TUI, then reload what it holds.
//
// The editor gets the terminal to itself: raw mode off, the kitty keyboard
// mode popped, and a blocking spawnSync so Ink reads nothing meanwhile.
// Terminal editors draw on the alternate screen, so teaminal's last frame
// is back as-is when they exit; GUI editors need a wait flag (`code -w`).

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { getConfigPath, loadSettings } from '../config'
import { getThemePath, loadThemeFile } from '../config/themes'
import { warn } from '../log'
import type { AppState, Store } from '../state/store'
import { kittyKeyboardEnabled } from './kittyKeyboard'

type Spawn = (cmd: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, 'status' | 'error'>

export function editorFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const editor = (env.VISUAL || env.EDITOR || '').trim()
  return editor || null
}

// Run `editor path` through sh so an editor with flags ("code -w") works;
// the path goes in as $1, never spliced into the command string.
export function runEditor(
  editor: string,
  path: string,
  spawn: Spawn = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }),
): boolean {
  const stdin = process.stdin
  const wasRaw = stdin.isTTY && stdin.isRaw
  const kitty = kittyKeyboardEnabled()
  if (wasRaw) stdin.setRawMode(false)
  if (kitty) process.stdout.write('\x1b[<u')
  try {
    const r = spawn('sh', ['-c', `${editor} "$1"`, 'sh', path])
    if (r.error) throw r.error
    if (r.status !== 0) warn(`editor: "${editor}" exited with status ${r.status}`)
    return r.status === 0
  } catch (err) {
    warn(`editor: failed to run "${editor}": ${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    if (kitty) process.stdout.write('\x1b[>1u')
    if (wasRaw) stdin.setRawMode(true)
  }
}

// The file Ctrl+T opens: a custom theme's own file, or config.json for a
// built-in theme, whose overrides live there under themeOverrides.
export function themeFileFor(themeName: string): string {
  return loadThemeFile(themeName).source === 'builtin' ? getConfigPath() : getThemePath(themeName)
}

export function editSettingsFile(store: Store<AppState>): void {
  const editor = editorFromEnv()
  if (!editor) return warn('editor: set $VISUAL or $EDITOR to edit the settings file')
  runEditor(editor, getConfigPath())
  reloadSettings(store)
}

export function editThemeFile(store: Store<AppState>): void {
  const editor = editorFromEnv()
  if (!editor) return warn('editor: set $VISUAL or $EDITOR to edit the theme file')
  runEditor(editor, themeFileFor(store.get().settings.theme))
  reloadSettings(store)
}

// Apply what's on disk now. A file that no longer parses keeps the current
// settings rather than falling back to defaults.
function reloadSettings(store: Store<AppState>): void {
  const loaded = loadSettings()
  for (const w of loaded.warnings) warn(w)
  if (loaded.source !== 'file') return
  const theme = loadThemeFile(loaded.settings.theme)
  for (const w of theme.warnings) warn(w)
  store.set({
    settings: loaded.settings,
    customTheme: theme.data ? { name: theme.name, data: theme.data } : store.get().customTheme,
  })
}
