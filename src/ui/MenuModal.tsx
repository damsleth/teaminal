// Modal pause-menu overlay.
//
// Activated by Esc when the user is in list focus + list inputZone (i.e.
// not editing, not filtering, not opening a chat). Renders inside the
// central pane area so the header / composer / status bar remain visible
// behind it - Ink does not support absolute positioning, so a true
// floating overlay is not possible; this is the closest approximation.
//
// Keys:
//   ↑/k       cursor up   (skips disabled items)
//   ↓/j       cursor down (skips disabled items)
//   Enter     activate item / toggle setting / open submenu
//   Esc       pop submenu / close at root
//   q         quick quit (only at root)
//
// Menu structure lives in ./menu - this component is the renderer + input
// dispatcher. Add menu items there, not here.

import { Box, Text, useApp, useStdout } from 'ink'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'
import {
  cycleQuietHoursPreset,
  cycleSetting,
  emptyAccountManagerModal,
  firstSelectable,
  nextSelectable,
  renderQuietHoursValue,
  menuItemWindow,
  renderSettingValue,
  resolveMenuPath,
  ROOT_MENU,
  stepIn,
  type MenuItem,
  type ToggleKey,
  updateSetting,
} from './menu'
import type { Settings } from '../state/store'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { useTerminalRows } from './hooks/useTerminalRows'
import { useSessionApi } from './SessionContext'
import { openThemeEditor } from './ThemeEditorModal'
import { openThemePresets } from './ThemePresetsModal'
import { loadThemePreset, themeChoices } from './themePresets'
import { openActivity } from './ActivityModal'
import { editSettingsFile, editThemeFile } from './openInEditor'
import { clearProfileCaches } from '../state/cacheClear'
import { updateSettings } from '../config'
import { recordEvent, warn } from '../log'
import { REPOSITORY_URL, VERSION } from '../version'

const LOGO = [
  '████████╗███████╗ █████╗ ███╗   ███╗██╗███╗   ██╗ █████╗ ██╗     ',
  '╚══██╔══╝██╔════╝██╔══██╗████╗ ████║██║████╗  ██║██╔══██╗██║     ',
  '   ██║   █████╗  ███████║██╔████╔██║██║██╔██╗ ██║███████║██║     ',
  '   ██║   ██╔══╝  ██╔══██║██║╚██╔╝██║██║██║╚██╗██║██╔══██║██║     ',
  '   ██║   ███████╗██║  ██║██║ ╚═╝ ██║██║██║ ╚████║██║  ██║███████╗',
  '   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝',
]

// Minimum width of the rendered menu rows (LOGO length). Every row is
// padded to the menu's width so each Text node writes a uniform-width run
// with the menu's background color — Ink's Box backgroundColor fill paints
// the box's rectangle, but when the menu sits behind cells the underlying
// chat has already written to we get more reliable opacity by also setting
// backgroundColor on each Text and padding so every cell of the row is
// covered.
const MENU_MIN_WIDTH = LOGO[0]!.length

function padTo(text: string, width: number): string {
  if (text.length >= width) return text
  return text + ' '.repeat(width - text.length)
}

export function openMenu(store: ReturnType<typeof useAppStore>, path: string[] = []): void {
  const items = resolveMenuPath(ROOT_MENU, path) ?? ROOT_MENU
  const idx = firstSelectable(items)
  store.set({
    modal: { kind: 'menu', path, cursor: idx === -1 ? 0 : idx },
    inputZone: 'menu',
  })
}

export function openAccounts(store: ReturnType<typeof useAppStore>): void {
  store.set({
    modal: emptyAccountManagerModal(),
    inputZone: 'menu',
  })
}

export function MenuModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const session = useSessionApi()
  const modal = useAppState((s) => s.modal)
  const settings = useAppState((s) => s.settings)
  const theme = useTheme()
  const terminalRows = useTerminalRows()
  const { stdout } = useStdout()
  const terminalColumns = stdout?.columns ?? 80
  const isOpen = modal?.kind === 'menu'

  useInput(
    (input, key) => {
      const ch = input.toLowerCase()
      const m = store.get().modal
      if (!m || m.kind !== 'menu') return
      const items = resolveMenuPath(ROOT_MENU, m.path) ?? ROOT_MENU

      if (key.escape) {
        if (m.path.length === 0) {
          store.set({ modal: null, inputZone: 'list' })
        } else {
          openMenu(store, m.path.slice(0, -1))
        }
        return
      }

      // Ctrl+O / Ctrl+T: edit the settings / theme file in $VISUAL.
      if (key.ctrl && ch === 'o') return editSettingsFile(store)
      if (key.ctrl && ch === 't') return editThemeFile(store)

      if (ch === 'q' && m.path.length === 0) {
        store.set({ modal: null, inputZone: 'list' })
        exit()
        return
      }

      if (key.upArrow || ch === 'k') {
        const next = nextSelectable(items, m.cursor, -1)
        if (next === -1) return
        store.set({ modal: { ...m, cursor: next } })
        return
      }
      if (key.downArrow || ch === 'j') {
        const next = nextSelectable(items, m.cursor, 1)
        if (next === -1) return
        store.set({ modal: { ...m, cursor: next } })
        return
      }
      // ←/→ step a value backwards / forwards (as in the theme editor); →
      // also opens a submenu.
      if (key.leftArrow || key.rightArrow) {
        const item = items[m.cursor]
        if (!item || item.disabled) return
        if (item.action.kind === 'submenu') {
          if (key.rightArrow) activate(item, m.path)
          return
        }
        adjust(item, key.rightArrow ? 1 : -1)
        return
      }
      // Space activates like Enter, in the root menu and every submenu.
      if (key.return || input === ' ') {
        const item = items[m.cursor]
        if (!item || item.disabled) return
        activate(item, m.path)
      }
    },
    { isActive: isOpen },
  )

  // Step a value item; false when the item has no value to step.
  function adjust(item: MenuItem, dir: 1 | -1): boolean {
    switch (item.action.kind) {
      case 'toggle-setting': {
        const key = item.action.key
        const current = store.get().settings[key]
        if (key === 'theme') {
          // Built-ins and saved presets; loading a preset also applies its
          // UI settings, like Theme presets → Enter.
          const names = themeChoices().map((c) => c.name)
          void loadThemePreset(store, stepIn(names, current as string, dir))
          return true
        }
        const next = cycleSetting(key, current, dir)
        void updateSetting(store, key, next).catch((err) => {
          warn(`config: failed to persist "${key}":`, errMessage(err))
        })
        return true
      }
      case 'toggle-header-element': {
        const key = item.action.key
        const cur = store.get().settings.headerElements
        const nextElements = { ...cur, [key]: !cur[key] }
        store.set((s) => ({ settings: { ...s.settings, headerElements: nextElements } }))
        void updateSettings({ headerElements: nextElements }).catch((err) => {
          warn(`config: failed to persist headerElements.${key}:`, errMessage(err))
        })
        return true
      }
      case 'cycle-quiet-hours': {
        const cur = store.get().settings
        const next = cycleQuietHoursPreset(
          { start: cur.quietHoursStart, end: cur.quietHoursEnd },
          dir,
        )
        store.set((s) => ({
          settings: { ...s.settings, quietHoursStart: next.start, quietHoursEnd: next.end },
        }))
        void updateSettings({
          quietHoursStart: next.start,
          quietHoursEnd: next.end,
        }).catch((err) => {
          warn('config: failed to persist quiet hours:', errMessage(err))
        })
        return true
      }
      default:
        return false
    }
  }

  function activate(item: MenuItem, path: string[]): void {
    if (adjust(item, 1)) return
    switch (item.action.kind) {
      case 'resume':
        store.set({ modal: null, inputZone: 'list' })
        return
      case 'quit':
        store.set({ modal: null, inputZone: 'list' })
        exit()
        return
      case 'submenu':
        openMenu(store, [...path, item.id])
        return
      case 'show-theme-editor':
        openThemeEditor(store)
        return
      case 'show-theme-presets':
        openThemePresets(store, 'menu')
        return
      case 'show-keybinds':
        store.set({ modal: { kind: 'keybinds' }, inputZone: 'menu' })
        return
      case 'show-diagnostics':
        store.set({ modal: { kind: 'diagnostics' }, inputZone: 'menu' })
        return
      case 'show-events':
        store.set({ modal: { kind: 'events' }, inputZone: 'menu' })
        return
      case 'show-network':
        store.set({ modal: { kind: 'network' }, inputZone: 'menu' })
        return
      case 'clear-cache': {
        const profile = session.getActiveProfile()
        try {
          const { removed } = clearProfileCaches(profile)
          recordEvent(
            'app',
            'info',
            `cache cleared for profile=${profile ?? '(default)'}: removed ${removed.length} item(s)`,
          )
        } catch (err) {
          warn('cache: clear failed:', errMessage(err))
        }
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      case 'show-accounts':
        openAccounts(store)
        return
      case 'show-notifications':
        openActivity(store)
        return
      case 'noop':
        // placeholders until backed by real flows
        return
    }
  }

  if (!isOpen || !modal || modal.kind !== 'menu') return null

  const items = resolveMenuPath(ROOT_MENU, modal.path) ?? ROOT_MENU
  const atRoot = modal.path.length === 0
  const breadcrumb = !atRoot ? modal.path.join(' / ') : null

  // The menu grows to fill the app (one row per item); only a list taller
  // than the window scrolls.
  const footer = '↑/↓ navigate · ←/→ change · enter select · esc back · ^O config · ^T theme'
  const reservedRows =
    4 /* header bar + status bar */ +
    (atRoot ? LOGO.length + 3 : 0) /* logo + version + repo + blank (root only) */ +
    (breadcrumb ? 2 : 0) +
    2 /* trailing blank + footer */ +
    2 /* ⋯ above / below */ +
    theme.layout.modalPaddingY * 2 +
    2 /* modal border */
  const maxVisible = Math.max(4, terminalRows - reservedRows)
  const { start, end } = menuItemWindow(items.length, modal.cursor, maxVisible)
  const moreAbove = start > 0
  const moreBelow = end < items.length
  const visibleItems = items.slice(start, end).map((item, i) => {
    const valueSuffix = formatValueSuffix(item, settings)
    const hint = item.hint ? `  (${item.hint})` : ''
    const marker = i + start === modal.cursor && !item.disabled ? '> ' : '  '
    return { item, idx: start + i, text: `${marker}${item.label}${valueSuffix}${hint}` }
  })
  // As wide as the longest row (all items, so scrolling doesn't resize it),
  // up to the window minus the modal frame.
  const maxWidth = Math.max(
    MENU_MIN_WIDTH,
    terminalColumns - 2 /* border */ - theme.layout.modalPaddingX * 2 - 2 /* margin */,
  )
  const width = Math.min(
    maxWidth,
    Math.max(
      MENU_MIN_WIDTH,
      footer.length,
      ...items.map(
        (it) =>
          2 +
          it.label.length +
          formatValueSuffix(it, settings).length +
          (it.hint ? it.hint.length + 4 : 0),
      ),
    ),
  )
  const pad = (text: string): string => padTo(text, width)

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={inkBorder(theme.borders.modal)}
        borderColor={theme.borderActive}
        backgroundColor={modalBg(theme)}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
      >
        {/* The ASCII logo + version/repo is branding for the root menu only.
            Submenus (especially the long Settings list) drop it so more rows
            are available for items — otherwise the centered overlay overflows
            and clips the top entries off-screen. */}
        {atRoot ? (
          <>
            <Box flexDirection="column">
              {LOGO.map((line, i) => (
                <Text key={i} color="cyan" backgroundColor={modalBg(theme)}>
                  {pad(line)}
                </Text>
              ))}
            </Box>
            <Text color="gray" backgroundColor={modalBg(theme)}>
              {pad(`teaminal ${VERSION}`)}
            </Text>
            <Text color="gray" backgroundColor={modalBg(theme)}>
              {pad(REPOSITORY_URL)}
            </Text>
            <Text backgroundColor={modalBg(theme)}>{pad('')}</Text>
          </>
        ) : null}
        {breadcrumb && (
          <>
            <Text color="gray" backgroundColor={modalBg(theme)}>
              {pad(breadcrumb)}
            </Text>
            <Text backgroundColor={modalBg(theme)}>{pad('')}</Text>
          </>
        )}
        <Box flexDirection="column">
          {moreAbove && (
            <Text color="gray" backgroundColor={modalBg(theme)}>
              {pad('  ⋯')}
            </Text>
          )}
          {visibleItems.map(({ item, idx, text }) => {
            const selected = idx === modal.cursor
            // Use theme.text (not the terminal default fg) so rows stay
            // readable on the themed modal background even when the active
            // terminal palette's default foreground doesn't match the theme.
            const color = item.disabled ? 'gray' : selected ? theme.selected : theme.text
            return (
              <Text
                key={item.id}
                color={color}
                backgroundColor={modalBg(theme)}
                bold={selected && !item.disabled && theme.emphasis.selectedBold}
                wrap="truncate-end"
              >
                {pad(text)}
              </Text>
            )
          })}
          {moreBelow && (
            <Text color="gray" backgroundColor={modalBg(theme)}>
              {pad('  ⋯')}
            </Text>
          )}
        </Box>
        <Text backgroundColor={modalBg(theme)}>{pad('')}</Text>
        <Text color="gray" backgroundColor={modalBg(theme)}>
          {pad(footer)}
        </Text>
      </Box>
    </Box>
  )
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatValueSuffix(item: MenuItem, settings: Settings): string {
  if (item.action.kind === 'toggle-setting') {
    const key = item.action.key as ToggleKey
    return ` : ${renderSettingValue(key, settings[key])}`
  }
  if (item.action.kind === 'cycle-quiet-hours') {
    return ` : ${renderQuietHoursValue(settings.quietHoursStart, settings.quietHoursEnd)}`
  }
  if (item.action.kind === 'toggle-header-element') {
    return ` : ${settings.headerElements[item.action.key] ? 'on' : 'off'}`
  }
  return ''
}
