// Live theme/layout editor overlay.
//
// Renders the editable-field list from src/ui/themeEditor.ts and edits each
// field in place — every change writes to settings.themeOverrides (or the
// backing Settings key) via the store + persist path, so the whole app
// re-renders against the new resolved theme immediately. A preview (beside
// the fields on wide windows, below otherwise) samples every text type.
//
// Keys:
//   ↑/k ↓/j     move between fields (wraps; viewport scrolls)
//   →/+ / space  step value forward (numeric +step, cycle color/enum, toggle)
//   ←/-          step value backward
//   e            edit a color as raw hex (#rgb / #rrggbb), enter to commit
//   r            reset the focused field to its default
//   R            reset ALL theme overrides
//   s / S        save into the active preset / save as a new preset
//   p            theme presets (load / save / delete)
//   esc          close
//
// The field list + all value math live in ./themeEditor; this component is
// the renderer + key dispatcher.

import { Box, useApp, useStdout } from 'ink'
import { Text } from './Text'
import { useInput } from './useInput'
import { useRef, useState, type ReactElement, type ReactNode } from 'react'
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
import { reservedBorder, blendAlpha, resolveBaseName, inkBorder, modalBg } from './theme'
import { useTerminalRows } from './hooks/useTerminalRows'
import { activeCustomThemeData, useAppState, useAppStore, useTheme } from './StoreContext'
import { openThemePresets } from './ThemePresetsModal'
import { activePresetName, saveThemePresetAs } from './themePresets'
import { bodyFrame } from './MessagePane'
import { fs } from './textSizing'
import type { Settings } from '../state/store'

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
  // Color edits are scoped to the built-in base currently rendered.
  const systemAppearance = useAppState((s) => s.systemAppearance)
  const customTheme = useAppState((s) => s.customTheme)
  const base = resolveBaseName(
    settings.theme,
    systemAppearance,
    activeCustomThemeData(settings.theme, customTheme)?.base,
  )
  const rows = useTerminalRows()
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 80
  const isOpen = modal?.kind === 'theme-editor'

  // Raw hex being typed for the focused color field. Lives here (not in modal
  // state) so the live re-render from a settings change doesn't reset it.
  const [hexEdit, setHexEdit] = useState<{ buffer: string } | null>(null)
  // Field rows visible at the last render; page keys move half of it.
  const pageRows = useRef(10)

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
    void persist(applyField(settings, f.field, nextFieldValue(f.field, cur, dir), base))
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
            if (f) void persist(applyField(settings, f.field, hexEdit.buffer, base))
            setHexEdit(null)
          }
          return
        }
        if (key.backspace || key.delete) {
          setHexEdit((h) => (h ? { buffer: h.buffer.slice(0, -1) || '#' } : h))
          return
        }
        if (/^[0-9a-fA-F]$/.test(input) && hexEdit.buffer.length < 9) {
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
        if (f) void persist(resetField(settings, f.field, base))
        return
      }
      if (input === 'e') {
        beginHexEdit()
        return
      }
      // Presets: s saves into the active preset (a built-in has no file, so
      // it asks for a name), S saves as a new one, p opens the list.
      if (input === 's') {
        const active = activePresetName(store.get())
        if (active) void saveThemePresetAs(store, active)
        else openThemePresets(store, 'theme-editor', '')
        return
      }
      if (input === 'S') {
        openThemePresets(store, 'theme-editor', '')
        return
      }
      if (input === 'p') {
        openThemePresets(store, 'theme-editor')
        return
      }

      const ch = input.toLowerCase()
      // PageUp / PageDown and u / d move half a page, stopping at the ends.
      if (key.pageUp || key.pageDown || ch === 'u' || ch === 'd') {
        const half = Math.max(1, Math.floor(pageRows.current / 2))
        const delta = key.pageUp || ch === 'u' ? -half : half
        const cursor = Math.max(0, Math.min(FIELDS.length - 1, m.cursor + delta))
        store.set({ modal: { kind: 'theme-editor', cursor } })
        return
      }
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
  // Display rows: a header before each section, then its fields. The window
  // is taken over these rows so section headers count against the height.
  const displayRows: ({ kind: 'header'; section: string } | { kind: 'field'; index: number })[] = []
  FIELDS.forEach((field, index) => {
    if (index === 0 || FIELDS[index - 1]!.section !== field.section)
      displayRows.push({ kind: 'header', section: field.section })
    displayRows.push({ kind: 'field', index })
  })
  const cursorRow = displayRows.findIndex((r) => r.kind === 'field' && r.index === cursor)
  // Preview beside the fields when the window is wide enough, else below.
  const side = columns >= CONTENT_W + PREVIEW_W + 2 * theme.layout.modalPaddingX + 8
  const chromeRows =
    4 /* header bar + status bar */ +
    2 /* modal border */ +
    2 * theme.layout.modalPaddingY +
    2 /* title + legend */ +
    2 /* ↑ / ↓ more */ +
    2 /* help */ +
    (side ? 0 : PREVIEW_ROWS + 1)
  const capacity = Math.max(5, rows - chromeRows)
  const { start, end } = fieldWindow(displayRows.length, Math.max(0, cursorRow), capacity)
  pageRows.current = Math.min(capacity, FIELDS.length)

  const bg = modalBg(theme)
  const rowNodes: ReactNode[] = displayRows.slice(start, end).map((row) => {
    if (row.kind === 'header')
      return (
        <Text key={`h-${row.section}`} color="gray" backgroundColor={bg}>
          {pad(`── ${row.section} `)}
        </Text>
      )
    const field = FIELDS[row.index]!
    return (
      <FieldRow
        key={field.id}
        field={field}
        selected={row.index === cursor}
        overridden={isOverridden(field, settings, base)}
        value={fieldValue(field, theme, settings)}
        hexBuffer={row.index === cursor && hexEdit ? hexEdit.buffer : null}
        theme={theme}
      />
    )
  })
  const fieldsAbove = displayRows.slice(0, start).filter((r) => r.kind === 'field').length
  const fieldsBelow = displayRows.slice(end).filter((r) => r.kind === 'field').length

  const fieldColumn = (
    <Box flexDirection="column" flexShrink={0}>
      {fieldsAbove > 0 && (
        <Text muted backgroundColor={bg}>
          {pad(`   ↑ ${fieldsAbove} more`)}
        </Text>
      )}
      {rowNodes}
      {fieldsBelow > 0 && (
        <Text muted backgroundColor={bg}>
          {pad(`   ↓ ${fieldsBelow} more`)}
        </Text>
      )}
    </Box>
  )

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={inkBorder(theme.borders.modal)}
        borderColor={theme.borderActive}
        backgroundColor={bg}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
      >
        <Text bold={theme.emphasis.modalTitleBold} backgroundColor={bg}>
          {pad(
            settings.theme === base
              ? `Theme editor · ${base} colors`
              : settings.theme === 'auto'
                ? `Theme editor · ${base} colors (picked by auto)`
                : `Theme editor · ${settings.theme} (${base})`,
          )}
        </Text>
        <Text muted backgroundColor={bg}>
          {pad('• = unsaved edit · s saves them into a preset')}
        </Text>
        {side ? (
          <Box flexDirection="row" backgroundColor={bg}>
            {fieldColumn}
            <Box width={2} flexShrink={0} />
            <ThemePreview theme={theme} settings={settings} />
          </Box>
        ) : (
          <>
            {fieldColumn}
            <Box marginTop={1}>
              <ThemePreview theme={theme} settings={settings} />
            </Box>
          </>
        )}
        <Text muted backgroundColor={bg}>
          {pad(
            hexEdit
              ? 'type hex · enter commit · esc cancel'
              : '↑↓/ud move · ←→ adjust · e hex · r reset · R reset all · esc',
          )}
        </Text>
        {!hexEdit && (
          <Text muted backgroundColor={bg}>
            {pad('s save preset · S save as · p presets (load / delete)')}
          </Text>
        )}
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
  const bg = modalBg(theme)
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
        <Text
          color={
            isHexColor(hexBuffer) ? blendAlpha(hexBuffer, theme.modalBackground) : theme.errorText
          }
          backgroundColor={bg}
        >
          {hexBuffer}
        </Text>
        <Text muted backgroundColor={bg}>
          _
        </Text>
      </>
    )
  } else if (field.kind === 'color') {
    if (value === null) {
      valueText = 'none'
      valueNode = (
        <Text muted backgroundColor={bg}>
          none
        </Text>
      )
    } else {
      const name = String(value)
      valueText = `██ ${name}`
      valueNode = (
        <>
          <Text color={blendAlpha(name, theme.modalBackground)} backgroundColor={bg}>
            ██
          </Text>
          <Text color={labelColor} backgroundColor={bg}>
            {` ${name}`}
          </Text>
        </>
      )
    }
  } else {
    const base =
      value === null && field.kind === 'numeric' && field.nullLabel
        ? field.nullLabel
        : formatFieldValue(value)
    const hint = selected && field.kind === 'numeric' ? ` (${field.min}–${field.max})` : ''
    valueText = base + hint
    valueNode = (
      <>
        <Text color={labelColor} backgroundColor={bg}>
          {base}
        </Text>
        {hint && (
          <Text muted backgroundColor={bg}>
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
      <Text color={selected ? theme.selected : theme.mutedText} backgroundColor={bg}>
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

// A sample of every text type the theme styles: the chat list, the message
// pane (chat header, date marker, sender / self names and timestamps, both
// kinds of message body with their backgrounds, the focused message, a
// system event) and the status colors. Reads the resolved theme, so it
// re-renders on every edit; font sizes show in kitty.
const PREVIEW_W = 40
const PREVIEW_ROWS = 24

function ThemePreview(props: {
  theme: ReturnType<typeof useTheme>
  settings: Settings
}): ReactElement {
  const { theme, settings } = props
  const bg = modalBg(theme)
  const tight = theme.fontSize.tightSpacing
  const listIndent = ' '.repeat(Math.max(0, theme.layout.chatListIndent))
  const senderIndent = Math.max(0, theme.layout.senderIndent)
  const bodyIndent = Math.max(1, theme.layout.paneHeaderPaddingLeft)
  const marker = settings.messageFocusIndicatorChar.slice(0, 1) || '>'

  // One message body: indent / focus marker column, then the text in its
  // background, padded and (rounded) framed as in MessagePane.
  const body = (
    text: string,
    color: string | undefined,
    background: string | null,
    opts: { focused?: boolean; self?: boolean } = {},
  ) => {
    // Same frame as MessagePane draws for this kind of body.
    const frame = bodyFrame(theme, {
      focused: opts.focused ?? false,
      self: opts.self ?? false,
      plain: false,
      background: background ?? undefined,
    })
    const textNode = (
      <Text
        color={color}
        backgroundColor={background ?? undefined}
        bold={opts.focused && theme.emphasis.focusedBold}
      >
        {fs(text, theme.fontSize.messageText)}
      </Text>
    )
    const framed =
      frame ||
      theme.layout.textBackgroundPaddingX > 0 ||
      theme.layout.textBackgroundPaddingY > 0 ? (
        <Box
          paddingX={theme.layout.textBackgroundPaddingX}
          paddingY={theme.layout.textBackgroundPaddingY}
          backgroundColor={background ?? undefined}
          borderStyle={frame?.style}
          borderColor={frame?.color}
        >
          {textNode}
        </Box>
      ) : (
        textNode
      )
    return (
      <Box flexDirection="row">
        <Box width={bodyIndent} flexShrink={0} paddingTop={frame ? 1 : 0}>
          <Text color={theme.messageFocusIndicator}>{opts.focused ? marker : ' '}</Text>
        </Box>
        {framed}
      </Box>
    )
  }
  const senderLine = (name: string, color: string, time: string) => (
    <Box flexDirection="row">
      {senderIndent > 0 && <Box width={senderIndent} flexShrink={0} />}
      <Text>
        <Text color={color} bold={theme.emphasis.senderBold}>
          {fs(name, theme.fontSize.sender, tight)}
        </Text>
        <Text color={theme.timestamp}>{fs(`  ${time}`, theme.fontSize.timestamp, tight)}</Text>
      </Text>
    </Box>
  )

  return (
    <Box
      flexDirection="column"
      width={PREVIEW_W}
      flexShrink={0}
      borderStyle={inkBorder(theme.borders.panel)}
      borderColor={theme.border}
      backgroundColor={theme.appBackground ?? bg}
    >
      {/* Chat list */}
      <Text color={theme.text} bold={theme.emphasis.sectionHeadingBold}>
        {fs('Chats', theme.fontSize.chatListHeader, tight)}
      </Text>
      <Box
        backgroundColor={theme.selectedRowBackground ?? undefined}
        borderStyle={reservedBorder(theme.borders.selectedRow, true)}
        borderColor={theme.selectedRowBorder ?? theme.borderActive}
      >
        <Text
          color={theme.selectedRow}
          backgroundColor={theme.selectedRowBackground ?? undefined}
          bold={theme.emphasis.selectedBold}
        >
          {`●${listIndent}`}
          {fs('Ada Byron', theme.fontSize.chatListName, tight)}
          {/* Fill the row, as the selection background does in the list. */}
          {' '.repeat(
            Math.max(
              0,
              PREVIEW_W -
                2 -
                (theme.borders.selectedRow === 'none' ? 0 : 2) -
                1 -
                listIndent.length -
                'Ada Byron'.length,
            ),
          )}
        </Text>
      </Box>
      <Text color={theme.unreadRow} bold={theme.emphasis.unreadBold}>
        {`●${listIndent}`}
        {fs('Design Sync', theme.fontSize.chatListName, tight)}
        <Text color={theme.unread}>{' · 3'}</Text>
      </Text>
      <Text color={theme.chatListPreviewText ?? theme.mutedText}>
        {` ${listIndent}`}
        {fs('Nina: shared two drafts', theme.fontSize.chatListPreview, tight)}
      </Text>
      <Text color={theme.border}>{'─'.repeat(PREVIEW_W - 2)}</Text>
      {/* Message pane */}
      <Text color={theme.text} bold={theme.emphasis.sectionHeadingBold}>
        {fs(' Ada Byron', theme.fontSize.paneHeader, tight)}
      </Text>
      <Box justifyContent={settings.centerDateMarkers ? 'center' : undefined}>
        {!settings.centerDateMarkers && theme.layout.dateMarkerIndent > 0 && (
          <Box width={theme.layout.dateMarkerIndent} flexShrink={0} />
        )}
        <Text color={theme.dateMarker} bold={theme.emphasis.dateMarkerBold}>
          {fs('Today', theme.fontSize.dateMarker, tight)}
        </Text>
      </Box>
      {senderLine('Ada', theme.sender, '12:34')}
      {body(
        'Launch notes are ready',
        theme.senderMessage ?? theme.text,
        theme.senderMessageBackground,
      )}
      {senderLine('You', theme.selfName, '12:36')}
      {body('Looks good, shipping', theme.selfMessage ?? theme.text, theme.selfMessageBackground, {
        self: true,
      })}
      {body(
        'Focused message',
        theme.messageFocusText ?? theme.senderMessage ?? theme.text,
        theme.messageFocusBackground,
        { focused: true },
      )}
      <Text>
        <Text color={theme.systemEvent}>{' · Ada joined the chat '}</Text>
        <Text color={theme.mutedText}>(edited)</Text>
      </Text>
      <Text color={theme.border}>{'─'.repeat(PREVIEW_W - 2)}</Text>
      <Text>
        <Text color={theme.errorText}>{'error '}</Text>
        <Text color={theme.warnText}>{'warn '}</Text>
        <Text color={theme.infoText}>info</Text>
      </Text>
    </Box>
  )
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
