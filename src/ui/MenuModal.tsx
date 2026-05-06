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
  renderSettingValue,
  resolveMenuPath,
  ROOT_MENU,
  type MenuItem,
  type ToggleKey,
  updateSetting,
} from './menu'
import type { Settings } from '../state/store'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { updateSettings } from '../config'
import { warn } from '../log'

const LOGO = [
  '████████╗███████╗ █████╗ ███╗   ███╗██╗███╗   ██╗ █████╗ ██╗     ',
  '╚══██╔══╝██╔════╝██╔══██╗████╗ ████║██║████╗  ██║██╔══██╗██║     ',
  '   ██║   █████╗  ███████║██╔████╔██║██║██╔██╗ ██║███████║██║     ',
  '   ██║   ██╔══╝  ██╔══██║██║╚██╔╝██║██║██║╚██╗██║██╔══██║██║     ',
  '   ██║   ███████╗██║  ██║██║ ╚═╝ ██║██║██║ ╚████║██║  ██║███████╗',
  '   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝',
]

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
  const modal = useAppState((s) => s.modal)
  const settings = useAppState((s) => s.settings)
  const theme = useTheme()
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
  const breadcrumb = modal.path.length > 0 ? modal.path.join(' / ') : null

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.borderActive}
        paddingX={3}
        paddingY={1}
      >
        <Box flexDirection="column">
          {LOGO.map((line, i) => (
            <Text key={i} color="cyan">
              {line}
            </Text>
          ))}
        </Box>
        <Box height={1} />
        {breadcrumb && (
          <Box marginBottom={1}>
            <Text color="gray">{breadcrumb}</Text>
          </Box>
        )}
        <Box flexDirection="column">
          {items.map((item, idx) => {
            const selected = idx === modal.cursor
            const marker = selected && !item.disabled ? '> ' : '  '
            const color = item.disabled ? 'gray' : selected ? theme.selected : undefined
            const valueSuffix = formatValueSuffix(item, settings)
            const hint = item.hint ? `  (${item.hint})` : ''
            return (
              <Text key={item.id} color={color} bold={selected && !item.disabled}>
                {marker}
                {item.label}
                {valueSuffix}
                {hint}
              </Text>
            )
          })}
        </Box>
        <Box height={1} />
        <Text color="gray">{'↑/↓ navigate · enter select · esc back'}</Text>
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
  return ''
}
