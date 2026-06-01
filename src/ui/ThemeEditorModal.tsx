// Live theme/layout editor overlay.
//
// Renders the editable-field list from src/ui/themeEditor.ts and edits each
// field in place — every change writes to settings.themeOverrides (or the
// backing Settings key) via the store + persist path, so the whole app
// re-renders against the new resolved theme immediately. A compact preview
// box at the bottom samples the tokens being tuned.
//
// Keys:
//   ↑/k ↓/j     move between fields (wraps; viewport scrolls)
//   →/+ / space  step value forward (numeric +step, cycle color/enum, toggle)
//   ←/-          step value backward
//   e            edit a color as raw hex (#rgb / #rrggbb), enter to commit
//   r            reset the focused field to its default
//   R            reset ALL theme overrides
//   esc          close
//
// The field list + all value math live in ./themeEditor; this component is
// the renderer + key dispatcher.

import { Box, Text, useApp, useInput } from 'ink'
import { useState, type ReactElement, type ReactNode } from 'react'
import { replaceThemeOverrides, updateSettings } from '../config'
import { warn } from '../log'
import {
  applyField,
  FIELDS,
  fieldValue,
  fieldWindow,
  formatFieldValue,
  isHexColor,
  isOverridden,
  moveCursor,
  nextFieldValue,
  resetAllOverrides,
  resetField,
  type EditableField,
  type FieldPatch,
} from './themeEditor'
import { useTerminalRows } from './hooks/useTerminalRows'
import { useAppState, useAppStore, useTheme } from './StoreContext'

const LABEL_W = 22
const CONTENT_W = 52

function pad(s: string): string {
  return s.length >= CONTENT_W ? s : s + ' '.repeat(CONTENT_W - s.length)
}

export function openThemeEditor(store: ReturnType<typeof useAppStore>): void {
  store.set({ modal: { kind: 'theme-editor', cursor: 0 }, inputZone: 'menu' })
}

export function ThemeEditorModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const settings = useAppState((s) => s.settings)
  const theme = useTheme()
  const rows = useTerminalRows()
  const isOpen = modal?.kind === 'theme-editor'

  // Raw hex being typed for the focused color field. Lives here (not in modal
  // state) so the live re-render from a settings change doesn't reset it.
  const [hexEdit, setHexEdit] = useState<{ buffer: string } | null>(null)

  async function persist(patch: FieldPatch): Promise<void> {
    if (patch.kind === 'overrides') {
      store.set((s) => ({ settings: { ...s.settings, themeOverrides: patch.overrides } }))
      try {
        await replaceThemeOverrides(patch.overrides)
      } catch (err) {
        warn('config: failed to persist theme overrides:', errMessage(err))
      }
    } else {
      store.set((s) => ({ settings: { ...s.settings, ...patch.patch } }))
      try {
        await updateSettings(patch.patch)
      } catch (err) {
        warn('config: failed to persist setting:', errMessage(err))
      }
    }
  }

  function focusedField(): { field: EditableField; cursor: number } | null {
    const m = store.get().modal
    if (!m || m.kind !== 'theme-editor') return null
    const field = FIELDS[m.cursor]
    if (!field) return null
    return { field, cursor: m.cursor }
  }

  function step(dir: 1 | -1): void {
    const f = focusedField()
    if (!f) return
    const cur = fieldValue(f.field, theme, settings)
    void persist(applyField(settings, f.field, nextFieldValue(f.field, cur, dir)))
  }

  function beginHexEdit(): void {
    const f = focusedField()
    if (!f || f.field.kind !== 'color') return
    const cur = fieldValue(f.field, theme, settings)
    setHexEdit({ buffer: typeof cur === 'string' && cur.startsWith('#') ? cur : '#' })
  }

  useInput(
    (input, key) => {
      const m = store.get().modal
      if (!m || m.kind !== 'theme-editor') return

      if (key.ctrl && input.toLowerCase() === 'c') {
        exit()
        return
      }

      // Hex-entry sub-mode owns all keys until it commits or cancels.
      if (hexEdit) {
        if (key.escape) {
          setHexEdit(null)
          return
        }
        if (key.return) {
          if (isHexColor(hexEdit.buffer)) {
            const f = focusedField()
            if (f) void persist(applyField(settings, f.field, hexEdit.buffer))
            setHexEdit(null)
          }
          return
        }
        if (key.backspace || key.delete) {
          setHexEdit((h) => (h ? { buffer: h.buffer.slice(0, -1) || '#' } : h))
          return
        }
        if (/^[0-9a-fA-F]$/.test(input) && hexEdit.buffer.length < 7) {
          setHexEdit((h) => (h ? { buffer: h.buffer + input } : h))
        }
        return
      }

      if (key.escape) {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      // Reset keys read raw input so shift-R (reset all) is distinct from r.
      if (input === 'R') {
        void persist(resetAllOverrides())
        return
      }
      if (input === 'r') {
        const f = focusedField()
        if (f) void persist(resetField(settings, f.field))
        return
      }
      if (input === 'e') {
        beginHexEdit()
        return
      }

      const ch = input.toLowerCase()
      if (key.upArrow || ch === 'k') {
        store.set({
          modal: { kind: 'theme-editor', cursor: moveCursor(m.cursor, -1, FIELDS.length) },
        })
        return
      }
      if (key.downArrow || ch === 'j') {
        store.set({
          modal: { kind: 'theme-editor', cursor: moveCursor(m.cursor, 1, FIELDS.length) },
        })
        return
      }
      if (key.leftArrow || input === '-' || input === '_') {
        step(-1)
        return
      }
      if (key.rightArrow || input === '+' || input === '=' || input === ' ' || key.return) {
        step(1)
        return
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen || !modal || modal.kind !== 'theme-editor') return null

  const cursor = modal.cursor
  // Field rows that fit, leaving room for the chrome (title, section headers,
  // preview box, help). Conservative so the overlay never overflows the pane.
  const capacity = Math.max(5, Math.min(16, rows - 22))
  const { start, end } = fieldWindow(FIELDS.length, cursor, capacity)

  const bg = theme.background
  let lastSection: string | null = null
  const rowNodes: ReactNode[] = []
  for (let gi = start; gi < end; gi++) {
    const field = FIELDS[gi]!
    if (field.section !== lastSection) {
      lastSection = field.section
      rowNodes.push(
        <Text key={`h-${field.section}`} color="gray" backgroundColor={bg}>
          {pad(`── ${field.section} `)}
        </Text>,
      )
    }
    rowNodes.push(
      <FieldRow
        key={field.id}
        field={field}
        selected={gi === cursor}
        overridden={isOverridden(field, settings)}
        value={fieldValue(field, theme, settings)}
        hexBuffer={gi === cursor && hexEdit ? hexEdit.buffer : null}
        theme={theme}
      />,
    )
  }

  const moreAbove = start > 0
  const moreBelow = end < FIELDS.length

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={theme.borders.modal}
        borderColor={theme.borderActive}
        backgroundColor={bg}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
      >
        <Text bold={theme.emphasis.modalTitleBold} backgroundColor={bg}>
          {pad('Theme editor')}
        </Text>
        <Text color="gray" backgroundColor={bg}>
          {pad('• = overridden · adjust live, persists to config')}
        </Text>
        {moreAbove && (
          <Text color="gray" backgroundColor={bg}>
            {pad(`   ↑ ${start} more`)}
          </Text>
        )}
        {rowNodes}
        {moreBelow && (
          <Text color="gray" backgroundColor={bg}>
            {pad(`   ↓ ${FIELDS.length - end} more`)}
          </Text>
        )}
        <ThemePreview theme={theme} />
        <Text color="gray" backgroundColor={bg}>
          {pad(
            hexEdit
              ? 'type hex · enter commit · esc cancel'
              : '↑↓ field · ←→ adjust · e hex · r reset · R reset all · esc',
          )}
        </Text>
      </Box>
    </Box>
  )
}

function FieldRow(props: {
  field: EditableField
  selected: boolean
  overridden: boolean
  value: ReturnType<typeof fieldValue>
  hexBuffer: string | null
  theme: ReturnType<typeof useTheme>
}): ReactElement {
  const { field, selected, overridden, value, hexBuffer, theme } = props
  const bg = theme.background
  const marker = selected ? '> ' : '  '
  const dot = overridden ? '• ' : '  '
  const label = field.label.padEnd(LABEL_W)
  const labelColor = selected ? theme.selected : theme.text

  // Plain-text length of the value portion, for right-pad to CONTENT_W so the
  // per-row background fills the whole width (the overlay sits on chat cells).
  let valueText: string
  let valueNode: ReactNode
  if (hexBuffer !== null) {
    valueText = `${hexBuffer}_`
    valueNode = (
      <>
        <Text color={isHexColor(hexBuffer) ? hexBuffer : theme.errorText} backgroundColor={bg}>
          {hexBuffer}
        </Text>
        <Text color="gray" backgroundColor={bg}>
          _
        </Text>
      </>
    )
  } else if (field.kind === 'color') {
    if (value === null) {
      valueText = 'none'
      valueNode = (
        <Text color="gray" backgroundColor={bg}>
          none
        </Text>
      )
    } else {
      const name = String(value)
      valueText = `██ ${name}`
      valueNode = (
        <>
          <Text color={name} backgroundColor={bg}>
            ██
          </Text>
          <Text color={labelColor} backgroundColor={bg}>
            {` ${name}`}
          </Text>
        </>
      )
    }
  } else {
    const base = formatFieldValue(value)
    const hint = selected && field.kind === 'numeric' ? ` (${field.min}–${field.max})` : ''
    valueText = base + hint
    valueNode = (
      <>
        <Text color={labelColor} backgroundColor={bg}>
          {base}
        </Text>
        {hint && (
          <Text color="gray" backgroundColor={bg}>
            {hint}
          </Text>
        )}
      </>
    )
  }

  const used = marker.length + dot.length + label.length + valueText.length
  const trailing = used >= CONTENT_W ? '' : ' '.repeat(CONTENT_W - used)

  return (
    <Text backgroundColor={bg}>
      <Text color={selected ? theme.selected : 'gray'} backgroundColor={bg}>
        {marker}
      </Text>
      <Text color={theme.warnText} backgroundColor={bg}>
        {dot}
      </Text>
      <Text color={labelColor} backgroundColor={bg} bold={selected && theme.emphasis.selectedBold}>
        {label}
      </Text>
      {valueNode}
      <Text backgroundColor={bg}>{trailing}</Text>
    </Text>
  )
}

// Compact sample of the tokens being tuned. Reads straight from the resolved
// theme, so it re-renders on every edit.
function ThemePreview(props: { theme: ReturnType<typeof useTheme> }): ReactElement {
  const { theme } = props
  const bg = theme.background
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle={theme.borders.panel}
      borderColor={theme.border}
      backgroundColor={bg}
    >
      <Text backgroundColor={bg}>
        <Text color={theme.sender} bold={theme.emphasis.senderBold} backgroundColor={bg}>
          {'Ada  '}
        </Text>
        <Text color={theme.text} backgroundColor={bg}>
          {'Sample message body  '}
        </Text>
        <Text color={theme.timestamp} backgroundColor={bg}>
          12:34
        </Text>
      </Text>
      <Text
        color={theme.selectedRow}
        backgroundColor={theme.selectedRowBackground ?? bg}
        bold={theme.emphasis.selectedBold}
      >
        {pad('  Selected chat row')}
      </Text>
      <Text color={theme.unread} backgroundColor={bg} bold={theme.emphasis.unreadBold}>
        {pad('  Unread chat · 3 new')}
      </Text>
      <Text backgroundColor={bg}>
        <Text color={theme.selfMessage} backgroundColor={bg}>
          {'You  '}
        </Text>
        <Text color={theme.systemEvent} backgroundColor={bg}>
          {'· joined the chat'}
        </Text>
      </Text>
      <Text backgroundColor={bg}>
        <Text color={theme.errorText} backgroundColor={bg}>
          {'error '}
        </Text>
        <Text color={theme.warnText} backgroundColor={bg}>
          {'warn '}
        </Text>
        <Text color={theme.infoText} backgroundColor={bg}>
          info
        </Text>
      </Text>
    </Box>
  )
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
