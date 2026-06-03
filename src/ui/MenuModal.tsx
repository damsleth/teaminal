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

import { Box, Text, useApp, useInput } from 'ink'
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
  type MenuItem,
  type ToggleKey,
  updateSetting,
} from './menu'
import type { Settings } from '../state/store'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { useTerminalRows } from './hooks/useTerminalRows'
import { useSessionApi } from './SessionContext'
import { openThemeEditor } from './ThemeEditorModal'
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

// Width of the rendered menu rows (LOGO length). Used to pad every
// row so each Text node writes a uniform-width run with the menu's
// background color — Ink's Box backgroundColor fill paints the box's
// rectangle, but when the menu sits behind cells the underlying chat
// has already written to we get more reliable opacity by also setting
// backgroundColor on each Text and padding so every cell of the row
// is covered.
const MENU_CONTENT_WIDTH = LOGO[0]!.length

function pad(text: string): string {
  if (text.length >= MENU_CONTENT_WIDTH) return text
  return text + ' '.repeat(MENU_CONTENT_WIDTH - text.length)
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
      if (key.return) {
        const item = items[m.cursor]
        if (!item || item.disabled) return
        activate(item, m.path)
      }
    },
    { isActive: isOpen },
  )

  function activate(item: MenuItem, path: string[]): void {
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
      case 'toggle-setting': {
        const key = item.action.key
        const next = cycleSetting(key, store.get().settings[key])
        void updateSetting(store, key, next).catch((err) => {
          warn(`config: failed to persist "${key}":`, errMessage(err))
        })
        return
      }
      case 'toggle-header-element': {
        const key = item.action.key
        const cur = store.get().settings.headerElements
        const nextElements = { ...cur, [key]: !cur[key] }
        store.set((s) => ({ settings: { ...s.settings, headerElements: nextElements } }))
        void updateSettings({ headerElements: nextElements }).catch((err) => {
          warn(`config: failed to persist headerElements.${key}:`, errMessage(err))
        })
        return
      }
      case 'cycle-quiet-hours': {
        const cur = store.get().settings
        const next = cycleQuietHoursPreset({
          start: cur.quietHoursStart,
          end: cur.quietHoursEnd,
        })
        store.set((s) => ({
          settings: { ...s.settings, quietHoursStart: next.start, quietHoursEnd: next.end },
        }))
        void updateSettings({
          quietHoursStart: next.start,
          quietHoursEnd: next.end,
        }).catch((err) => {
          warn('config: failed to persist quiet hours:', errMessage(err))
        })
        return
      }
      case 'show-theme-editor':
        openThemeEditor(store)
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
      case 'noop':
        // placeholders until backed by real flows
        return
    }
  }

  if (!isOpen || !modal || modal.kind !== 'menu') return null

  const items = resolveMenuPath(ROOT_MENU, modal.path) ?? ROOT_MENU
  const atRoot = modal.path.length === 0
  const breadcrumb = !atRoot ? modal.path.join(' / ') : null

  // Each menu row visually consumes ~2 terminal rows in this layout, and the
  // modal is centered inside the message pane. Window the items so a long
  // submenu (Settings) fits without clipping the top/bottom off-screen.
  const PER_ITEM_ROWS = 2
  const reservedRows =
    8 /* outer header + composer + status + frame */ +
    (atRoot ? LOGO.length + 3 : 0) /* logo + version + repo + blank (root only) */ +
    (breadcrumb ? 2 : 0) +
    4 /* trailing blank + footer + ⋯ headroom */ +
    theme.layout.modalPaddingY * 2 +
    2 /* modal border */
  const maxVisible = Math.max(4, Math.floor((terminalRows - reservedRows) / PER_ITEM_ROWS))
  const { start, end } = menuItemWindow(items.length, modal.cursor, maxVisible)
  const moreAbove = start > 0
  const moreBelow = end < items.length
  const visibleItems = items.slice(start, end).map((item, i) => ({ item, idx: start + i }))

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={theme.borders.modal}
        borderColor={theme.borderActive}
        backgroundColor={theme.background}
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
                <Text key={i} color="cyan" backgroundColor={theme.background}>
                  {pad(line)}
                </Text>
              ))}
            </Box>
            <Text color="gray" backgroundColor={theme.background}>
              {pad(`teaminal ${VERSION}`)}
            </Text>
            <Text color="gray" backgroundColor={theme.background}>
              {pad(REPOSITORY_URL)}
            </Text>
            <Text backgroundColor={theme.background}>{pad('')}</Text>
          </>
        ) : null}
        {breadcrumb && (
          <>
            <Text color="gray" backgroundColor={theme.background}>
              {pad(breadcrumb)}
            </Text>
            <Text backgroundColor={theme.background}>{pad('')}</Text>
          </>
        )}
        <Box flexDirection="column">
          {moreAbove && (
            <Text color="gray" backgroundColor={theme.background}>
              {pad('  ⋯')}
            </Text>
          )}
          {visibleItems.map(({ item, idx }) => {
            const selected = idx === modal.cursor
            const marker = selected && !item.disabled ? '> ' : '  '
            // Use theme.text (not the terminal default fg) so rows stay
            // readable on the themed modal background even when the active
            // terminal palette's default foreground doesn't match the theme.
            const color = item.disabled ? 'gray' : selected ? theme.selected : theme.text
            const valueSuffix = formatValueSuffix(item, settings)
            const hint = item.hint ? `  (${item.hint})` : ''
            return (
              <Text
                key={item.id}
                color={color}
                backgroundColor={theme.background}
                bold={selected && !item.disabled && theme.emphasis.selectedBold}
              >
                {pad(`${marker}${item.label}${valueSuffix}${hint}`)}
              </Text>
            )
          })}
          {moreBelow && (
            <Text color="gray" backgroundColor={theme.background}>
              {pad('  ⋯')}
            </Text>
          )}
        </Box>
        <Text backgroundColor={theme.background}>{pad('')}</Text>
        <Text color="gray" backgroundColor={theme.background}>
          {pad('↑/↓ navigate · enter select · esc back')}
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
