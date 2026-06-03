// Data model for the live theme/layout editor (ThemeEditorModal).
//
// The editor renders entirely from the FIELDS descriptor list: each entry
// declares a label, a value kind (numeric / color / enum / boolean), where
// the value is stored, and (for numerics) its bounds. This keeps the React
// component a thin renderer + key dispatcher — adding a tunable token is a
// one-line addition here.
//
// Storage targets ("group"):
//   color     - a flat color token in settings.themeOverrides.<key>
//   layout    - settings.themeOverrides.layout.<key>   (ThemeLayout)
//   borders   - settings.themeOverrides.borders.<key>  (ThemeBorders)
//   emphasis  - settings.themeOverrides.emphasis.<key> (ThemeEmphasis)
//   setting   - a top-level Settings key (e.g. inlineImageMaxRows)
//
// Theme-token edits persist by REPLACING settings.themeOverrides wholesale
// (config.replaceThemeOverrides) so per-field reset can delete a key; setting
// edits persist through the normal updateSettings merge path. Both routes are
// wired in ThemeEditorModal.

import { defaultSettings, type Settings, type ThemeOverrides } from '../state/store'
import { BORDER_STYLES, type Theme } from './theme'

export type FieldKind = 'numeric' | 'color' | 'enum' | 'boolean'
export type FieldGroup = 'color' | 'layout' | 'borders' | 'emphasis' | 'setting'
export type EditorSection = 'Spacing / Layout' | 'Colors' | 'Borders' | 'Emphasis' | 'Images'

export type FieldValue = string | number | boolean | null

type BaseField = {
  id: string
  label: string
  section: EditorSection
  group: FieldGroup
  // The key within the group's storage target (an override token name, a
  // layout/borders/emphasis key, or a Settings key for `setting`).
  key: string
}

export type NumericField = BaseField & {
  kind: 'numeric'
  min: number
  max: number
  step: number
}
export type ColorField = BaseField & {
  kind: 'color'
  // Nullable color tokens (messageFocusBackground, selectedRowBackground)
  // accept null ("none") in addition to a named/hex color.
  nullable: boolean
}
export type EnumField = BaseField & {
  kind: 'enum'
  options: readonly string[]
}
export type BooleanField = BaseField & { kind: 'boolean' }

export type EditableField = NumericField | ColorField | EnumField | BooleanField

// Palette cycled by ←/→ on color fields. Named ANSI colors first (these
// round-trip through any terminal palette), then a few useful hex shades so
// backgrounds/tints can be dialed in without dropping to hex-entry mode.
// Hex-entry mode ('e') still accepts any #rgb / #rrggbb value.
export const COLOR_PALETTE: readonly string[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
  '#1c1c1c',
  '#262626',
  '#3a3a3a',
  '#767676',
  '#e6e6e6',
  '#ffffff',
]

const HEX_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value)
}

const color = (key: string, label: string, nullable = false): ColorField => ({
  kind: 'color',
  id: `color.${key}`,
  label,
  section: 'Colors',
  group: 'color',
  key,
  nullable,
})
const num = (
  group: 'layout' | 'setting',
  key: string,
  label: string,
  section: EditorSection,
  min: number,
  max: number,
  step = 1,
): NumericField => ({
  kind: 'numeric',
  id: `${group}.${key}`,
  label,
  section,
  group,
  key,
  min,
  max,
  step,
})
const border = (key: 'panel' | 'modal', label: string): EnumField => ({
  kind: 'enum',
  id: `borders.${key}`,
  label,
  section: 'Borders',
  group: 'borders',
  key,
  options: BORDER_STYLES,
})
const bool = (key: string, label: string): BooleanField => ({
  kind: 'boolean',
  id: `emphasis.${key}`,
  label,
  section: 'Emphasis',
  group: 'emphasis',
  key,
})

// Section order is the render order. Numeric + color come first (the most
// iterated-on tokens), then borders / emphasis / image sizing.
export const FIELDS: readonly EditableField[] = [
  // — Spacing / Layout —
  num('layout', 'panePaddingX', 'Pane padding X', 'Spacing / Layout', 0, 6),
  num('layout', 'modalPaddingX', 'Modal padding X', 'Spacing / Layout', 0, 8),
  num('layout', 'modalPaddingY', 'Modal padding Y', 'Spacing / Layout', 0, 4),
  num('layout', 'paneHeaderPaddingLeft', 'Message body indent', 'Spacing / Layout', 0, 6),
  num('layout', 'paneHeaderMarginBottom', 'Message gap', 'Spacing / Layout', 0, 4),
  num('layout', 'tailGap', 'Tail strip gap', 'Spacing / Layout', 0, 6),
  num('layout', 'chatListPaddingRight', 'Chat list pad R', 'Spacing / Layout', 0, 6),
  // — Colors —
  color('background', 'Background'),
  color('text', 'Text'),
  color('mutedText', 'Muted text'),
  color('border', 'Border'),
  color('borderActive', 'Active border'),
  color('selected', 'Selected'),
  color('selectedRow', 'Selected row'),
  color('selectedRowBackground', 'Selected row bg', true),
  color('unread', 'Unread'),
  color('unreadRow', 'Unread row'),
  color('timestamp', 'Timestamp'),
  color('sender', 'Sender'),
  color('selfMessage', 'Self message'),
  color('systemEvent', 'System event'),
  color('errorText', 'Error text'),
  color('warnText', 'Warn text'),
  color('infoText', 'Info text'),
  color('messageFocusIndicator', 'Focus marker'),
  color('messageFocusBackground', 'Focus background', true),
  // — Borders —
  border('panel', 'Panel border'),
  border('modal', 'Modal border'),
  // — Emphasis —
  bool('modalTitleBold', 'Modal title bold'),
  bool('sectionHeadingBold', 'Section heading bold'),
  bool('selectedBold', 'Selected bold'),
  bool('unreadBold', 'Unread bold'),
  bool('senderBold', 'Sender bold'),
  bool('inlineKeyBold', 'Inline key bold'),
  // — Images —
  num('setting', 'inlineImageMaxRows', 'Inline image max rows', 'Images', 1, 50),
  {
    kind: 'enum',
    id: 'setting.inlineImages',
    label: 'Inline images',
    section: 'Images',
    group: 'setting',
    key: 'inlineImages',
    options: ['auto', 'off'],
  },
]

// Resolved value currently in effect for a field (override if set, else the
// base theme / default setting). Drives both the displayed value and the live
// preview.
export function fieldValue(field: EditableField, theme: Theme, settings: Settings): FieldValue {
  switch (field.group) {
    case 'color':
      return (theme as unknown as Record<string, string | null>)[field.key] ?? null
    case 'layout':
      return (theme.layout as unknown as Record<string, number>)[field.key]!
    case 'borders':
      return (theme.borders as unknown as Record<string, string>)[field.key]!
    case 'emphasis':
      return (theme.emphasis as unknown as Record<string, boolean>)[field.key]!
    case 'setting':
      return (settings as unknown as Record<string, FieldValue>)[field.key]!
  }
}

// Whether the field currently carries an override (or, for setting-backed
// fields, differs from the built-in default). Used for the "•" override
// marker and to gate per-field reset.
export function isOverridden(field: EditableField, settings: Settings): boolean {
  const ov = settings.themeOverrides
  switch (field.group) {
    case 'color':
      return (ov as Record<string, unknown>)[field.key] !== undefined
    case 'layout':
      return (ov.layout as Record<string, unknown> | undefined)?.[field.key] !== undefined
    case 'borders':
      return (ov.borders as Record<string, unknown> | undefined)?.[field.key] !== undefined
    case 'emphasis':
      return (ov.emphasis as Record<string, unknown> | undefined)?.[field.key] !== undefined
    case 'setting': {
      const k = field.key as keyof Settings
      return JSON.stringify(settings[k]) !== JSON.stringify(defaultSettings[k])
    }
  }
}

export function clampNumeric(field: NumericField, value: number): number {
  const v = Math.round(value)
  if (Number.isNaN(v)) return field.min
  return Math.max(field.min, Math.min(field.max, v))
}

function colorOptions(field: ColorField): FieldValue[] {
  return field.nullable ? [null, ...COLOR_PALETTE] : [...COLOR_PALETTE]
}

export function cycleColor(field: ColorField, current: FieldValue, dir: 1 | -1): FieldValue {
  const opts = colorOptions(field)
  const idx = opts.findIndex((o) => o === current)
  if (idx === -1) return dir > 0 ? opts[0]! : opts[opts.length - 1]!
  return opts[(idx + dir + opts.length) % opts.length]!
}

export function cycleEnum(field: EnumField, current: FieldValue, dir: 1 | -1): string {
  const opts = field.options
  const idx = opts.indexOf(current as string)
  if (idx === -1) return opts[0]!
  return opts[(idx + dir + opts.length) % opts.length]!
}

// Next value for a directional step (dir = +1 / -1). Numerics step+clamp,
// enums/colors cycle, booleans toggle (direction ignored).
export function nextFieldValue(field: EditableField, current: FieldValue, dir: 1 | -1): FieldValue {
  switch (field.kind) {
    case 'numeric':
      return clampNumeric(
        field,
        (typeof current === 'number' ? current : field.min) + dir * field.step,
      )
    case 'color':
      return cycleColor(field, current, dir)
    case 'enum':
      return cycleEnum(field, current, dir)
    case 'boolean':
      return !current
  }
}

// Deep-copy only the sub-objects that actually exist. Spreading
// `presence: undefined` etc. would leave explicit-undefined keys that the
// config validator rejects ("presence must be a JSON object").
function cloneOverrides(ov: ThemeOverrides): ThemeOverrides {
  const next: ThemeOverrides = { ...ov }
  if (ov.presence) next.presence = { ...ov.presence }
  if (ov.layout) next.layout = { ...ov.layout }
  if (ov.borders) next.borders = { ...ov.borders }
  if (ov.emphasis) next.emphasis = { ...ov.emphasis }
  return next
}

// Drop an empty sub-object so cleared overrides round-trip back to {} rather
// than leaving "layout": {} cruft in config.json.
function pruneEmpty<K extends 'layout' | 'borders' | 'emphasis'>(ov: ThemeOverrides, key: K): void {
  const sub = ov[key]
  if (sub && Object.keys(sub).length === 0) delete ov[key]
}

function setOverride(ov: ThemeOverrides, field: EditableField, value: FieldValue): ThemeOverrides {
  const next = cloneOverrides(ov)
  switch (field.group) {
    case 'color':
      ;(next as Record<string, unknown>)[field.key] = value
      break
    case 'layout':
      next.layout = { ...next.layout, [field.key]: value as number }
      break
    case 'borders': {
      const b: Record<string, unknown> = { ...next.borders }
      b[field.key] = value
      next.borders = b as ThemeOverrides['borders']
      break
    }
    case 'emphasis':
      next.emphasis = { ...next.emphasis, [field.key]: value as boolean }
      break
  }
  return next
}

function clearOverride(ov: ThemeOverrides, field: EditableField): ThemeOverrides {
  const next = cloneOverrides(ov)
  switch (field.group) {
    case 'color':
      delete (next as Record<string, unknown>)[field.key]
      break
    case 'layout':
      if (next.layout) {
        delete (next.layout as Record<string, unknown>)[field.key]
        pruneEmpty(next, 'layout')
      }
      break
    case 'borders':
      if (next.borders) {
        delete (next.borders as Record<string, unknown>)[field.key]
        pruneEmpty(next, 'borders')
      }
      break
    case 'emphasis':
      if (next.emphasis) {
        delete (next.emphasis as Record<string, unknown>)[field.key]
        pruneEmpty(next, 'emphasis')
      }
      break
  }
  return next
}

// A persist instruction the modal routes to the right path: `themeOverrides`
// replaces the whole override object; `setting` is a normal settings patch.
export type FieldPatch =
  | { kind: 'overrides'; overrides: ThemeOverrides }
  | { kind: 'setting'; patch: Partial<Settings> }

export function applyField(
  settings: Settings,
  field: EditableField,
  value: FieldValue,
): FieldPatch {
  if (field.group === 'setting') {
    return { kind: 'setting', patch: { [field.key]: value } as Partial<Settings> }
  }
  return { kind: 'overrides', overrides: setOverride(settings.themeOverrides, field, value) }
}

export function resetField(settings: Settings, field: EditableField): FieldPatch {
  if (field.group === 'setting') {
    const k = field.key as keyof Settings
    return { kind: 'setting', patch: { [k]: defaultSettings[k] } as Partial<Settings> }
  }
  return { kind: 'overrides', overrides: clearOverride(settings.themeOverrides, field) }
}

// Global reset clears every theme override back to {}. Setting-backed fields
// (the Images section) are not theme overrides and keep their values; reset
// those individually with per-field reset.
export function resetAllOverrides(): FieldPatch {
  return { kind: 'overrides', overrides: {} }
}

export function anyOverridden(settings: Settings): boolean {
  return FIELDS.some((f) => f.group !== 'setting' && isOverridden(f, settings))
}

// Viewport window over the flat field list: keeps `cursor` centered within a
// `capacity`-row slice. Returns a [start, end) half-open range.
export function fieldWindow(
  count: number,
  cursor: number,
  capacity: number,
): { start: number; end: number } {
  if (capacity <= 0 || count <= capacity) return { start: 0, end: count }
  let start = cursor - Math.floor(capacity / 2)
  start = Math.max(0, Math.min(start, count - capacity))
  return { start, end: start + capacity }
}

// Move the cursor by `delta` over the field list, wrapping at both ends.
export function moveCursor(cursor: number, delta: number, count: number): number {
  if (count === 0) return 0
  return (cursor + delta + count) % count
}

// Render-ready value string for a field's current value.
export function formatFieldValue(value: FieldValue): string {
  if (value === null) return 'none'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return String(value)
}
