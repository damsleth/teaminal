// Data model for the live theme/layout editor (ThemeEditorModal).
//
// The editor renders entirely from the FIELDS descriptor list: each entry
// declares a label, a value kind (numeric / color / enum / boolean), where
// the value is stored, and (for numerics) its bounds. This keeps the React
// component a thin renderer + key dispatcher — adding a tunable token is a
// one-line addition here.
//
// Storage targets ("group"):
//   color     - settings.themeOverrides.<base>.<key>, where <base> is the
//               resolved built-in base (dark/light) being edited. Legacy flat
//               settings.themeOverrides.<key> still counts as an override.
//   layout    - settings.themeOverrides.layout.<key>   (ThemeLayout)
//   borders   - settings.themeOverrides.borders.<key>  (ThemeBorders)
//   emphasis  - settings.themeOverrides.emphasis.<key> (ThemeEmphasis)
//   fontSize  - settings.themeOverrides.fontSize.<key> (ThemeFontSize)
//   setting   - a top-level Settings key (e.g. inlineImageMaxRows)
//
// Theme-token edits persist by REPLACING settings.themeOverrides wholesale
// (config.replaceThemeOverrides) so per-field reset can delete a key; setting
// edits persist through the normal updateSettings merge path. Both routes are
// wired in ThemeEditorModal.

import { defaultSettings, type Settings, type ThemeOverrides } from '../state/store'
import { BORDER_STYLES, type BuiltinThemeName, type Theme } from './theme'

export type FieldKind = 'numeric' | 'color' | 'enum' | 'boolean'
export type FieldGroup = 'color' | 'layout' | 'borders' | 'emphasis' | 'fontSize' | 'setting'
export type EditorSection =
  | 'General'
  | 'Modals'
  | 'Chat list'
  | 'Sender & time'
  | 'Message text'
  | 'Focused message'
  | 'Date markers'
  | 'Status text'
  | 'Images'

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
  // Nullable color tokens (messageFocusBackground, messageFocusText, ...)
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
// Hex-entry mode ('e') accepts #rgb / #rrggbb, plus #rgba / #rrggbbaa
// with opacity (blended onto the theme background, see blendAlpha).
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
  '#999999',
  '#e6e6e6',
  '#ffffff',
]

const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value)
}

const color = (
  key: string,
  label: string,
  section: EditorSection,
  nullable = false,
): ColorField => ({
  kind: 'color',
  id: `color.${key}`,
  label,
  section,
  group: 'color',
  key,
  nullable,
})
const num = (
  group: 'layout' | 'fontSize' | 'setting',
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
const border = (
  key: 'panel' | 'modal' | 'active',
  label: string,
  section: EditorSection,
): EnumField => ({
  kind: 'enum',
  id: `borders.${key}`,
  label,
  section,
  group: 'borders',
  key,
  options: BORDER_STYLES,
})
const bool = (
  key: string,
  label: string,
  section: EditorSection,
  group: 'emphasis' | 'fontSize' = 'emphasis',
): BooleanField => ({
  kind: 'boolean',
  id: `${group}.${key}`,
  label,
  section,
  group,
  key,
})

// Sections follow the UI, top to bottom: the frame (General, Modals), the
// chat list, then the message pane (senders, bodies, focus, dates), status
// text and images. Each field still stores in its own group.
export const FIELDS: readonly EditableField[] = [
  // — General —
  color('appBackground', 'Background', 'General', true),
  color('text', 'Text', 'General'),
  color('mutedText', 'Muted text', 'General'),
  color('border', 'Border', 'General'),
  color('borderActive', 'Active border', 'General'),
  border('panel', 'Panel border', 'General'),
  border('active', 'Active pane border', 'General'),
  bool('sectionHeadingBold', 'Section heading bold', 'General'),
  bool('tightSpacing', 'Tight font spacing', 'General', 'fontSize'),
  // — Modals —
  color('modalBackground', 'Modal bg', 'Modals', true),
  border('modal', 'Modal border', 'Modals'),
  num('layout', 'modalPaddingX', 'Modal padding X', 'Modals', 0, 8),
  num('layout', 'modalPaddingY', 'Modal padding Y', 'Modals', 0, 4),
  bool('modalTitleBold', 'Modal title bold', 'Modals'),
  bool('inlineKeyBold', 'Inline key bold', 'Modals'),
  // — Chat list —
  color('selected', 'Selected', 'Chat list'),
  color('selectedRow', 'Selected row', 'Chat list'),
  color('selectedRowBackground', 'Selected row bg', 'Chat list', true),
  bool('selectedBold', 'Selected bold', 'Chat list'),
  color('unread', 'Unread', 'Chat list'),
  color('unreadRow', 'Unread row', 'Chat list'),
  bool('unreadBold', 'Unread bold', 'Chat list'),
  num('layout', 'chatListIndent', 'Indent', 'Chat list', 0, 6),
  num('layout', 'chatListGap', 'Gap', 'Chat list', 0, 3),
  num('fontSize', 'chatListHeader', 'Header size', 'Chat list', 50, 100, 10),
  num('fontSize', 'chatListName', 'Name size', 'Chat list', 50, 100, 10),
  num('fontSize', 'chatListPreview', 'Preview size', 'Chat list', 50, 100, 10),
  // — Sender & time —
  num('fontSize', 'paneHeader', 'Chat header size', 'Sender & time', 50, 100, 10),
  color('sender', 'Sender', 'Sender & time'),
  color('selfName', 'Self name', 'Sender & time'),
  bool('senderBold', 'Sender bold', 'Sender & time'),
  num('fontSize', 'sender', 'Sender size', 'Sender & time', 50, 100, 10),
  num('layout', 'senderIndent', 'Sender indent', 'Sender & time', 0, 6),
  color('timestamp', 'Timestamp', 'Sender & time'),
  num('fontSize', 'timestamp', 'Timestamp size', 'Sender & time', 50, 100, 10),
  // — Message text —
  color('senderMessage', 'Sender message', 'Message text', true),
  color('senderMessageBackground', 'Sender message bg', 'Message text', true),
  color('selfMessage', 'Self message', 'Message text'),
  color('selfMessageBackground', 'Self message bg', 'Message text', true),
  color('systemEvent', 'System event', 'Message text'),
  num('fontSize', 'messageText', 'Text size', 'Message text', 50, 100, 10),
  num('layout', 'paneHeaderPaddingLeft', 'Body indent', 'Message text', 0, 6),
  num('layout', 'paneHeaderMarginBottom', 'Message gap', 'Message text', 0, 4, 0.5),
  num('layout', 'messageMaxWidth', 'Conversation width %', 'Message text', 10, 100, 10),
  num('layout', 'textBackgroundPaddingX', 'Bg padding X', 'Message text', 0, 3),
  num('layout', 'textBackgroundPaddingY', 'Bg padding Y', 'Message text', 0, 2),
  num('layout', 'textBackgroundRadius', 'Bg rounded', 'Message text', 0, 1),
  // — Focused message —
  color('messageFocusIndicator', 'Focus marker', 'Focused message'),
  color('messageFocusText', 'Focus text', 'Focused message', true),
  color('messageFocusBackground', 'Focus background', 'Focused message', true),
  bool('focusedBold', 'Focused bold', 'Focused message'),
  // — Date markers —
  color('dateMarker', 'Date marker', 'Date markers'),
  bool('dateMarkerBold', 'Date marker bold', 'Date markers'),
  num('layout', 'dateMarkerIndent', 'Date marker indent', 'Date markers', 0, 12),
  num('fontSize', 'dateMarker', 'Date marker size', 'Date markers', 50, 100, 10),
  // — Status text —
  color('errorText', 'Error text', 'Status text'),
  color('warnText', 'Warn text', 'Status text'),
  color('infoText', 'Info text', 'Status text'),
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
      return (
        theme.rawColors?.[field.key] ??
        (theme as unknown as Record<string, string | null>)[field.key] ??
        null
      )
    case 'layout':
      return (theme.layout as unknown as Record<string, number>)[field.key]!
    case 'borders':
      return (theme.borders as unknown as Record<string, string>)[field.key]!
    case 'emphasis':
      return (theme.emphasis as unknown as Record<string, boolean>)[field.key]!
    case 'fontSize':
      return (theme.fontSize as unknown as Record<string, number | boolean>)[field.key]!
    case 'setting':
      return (settings as unknown as Record<string, FieldValue>)[field.key]!
  }
}

// Whether the field currently carries an override (or, for setting-backed
// fields, differs from the built-in default). Used for the "•" override
// marker and to gate per-field reset.
export function isOverridden(
  field: EditableField,
  settings: Settings,
  base: BuiltinThemeName,
): boolean {
  const ov = settings.themeOverrides
  switch (field.group) {
    case 'color':
      return (
        (ov as Record<string, unknown>)[field.key] !== undefined ||
        (ov[base] as Record<string, unknown> | undefined)?.[field.key] !== undefined
      )
    case 'layout':
      return (ov.layout as Record<string, unknown> | undefined)?.[field.key] !== undefined
    case 'borders':
      return (ov.borders as Record<string, unknown> | undefined)?.[field.key] !== undefined
    case 'emphasis':
      return (ov.emphasis as Record<string, unknown> | undefined)?.[field.key] !== undefined
    case 'fontSize':
      return (ov.fontSize as Record<string, unknown> | undefined)?.[field.key] !== undefined
    case 'setting': {
      const k = field.key as keyof Settings
      return JSON.stringify(settings[k]) !== JSON.stringify(defaultSettings[k])
    }
  }
}

export function clampNumeric(field: NumericField, value: number): number {
  const v = Math.round(value / field.step) * field.step
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
  if (ov.fontSize) next.fontSize = { ...ov.fontSize }
  if (ov.dark) next.dark = { ...ov.dark }
  if (ov.light) next.light = { ...ov.light }
  return next
}

// Drop an empty sub-object so cleared overrides round-trip back to {} rather
// than leaving "layout": {} cruft in config.json.
function pruneEmpty<K extends 'layout' | 'borders' | 'emphasis' | 'fontSize' | BuiltinThemeName>(
  ov: ThemeOverrides,
  key: K,
): void {
  const sub = ov[key]
  if (sub && Object.keys(sub).length === 0) delete ov[key]
}

function setOverride(
  ov: ThemeOverrides,
  field: EditableField,
  value: FieldValue,
  base: BuiltinThemeName,
): ThemeOverrides {
  const next = cloneOverrides(ov)
  switch (field.group) {
    case 'color':
      next[base] = { ...next[base], [field.key]: value }
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
    case 'fontSize':
      next.fontSize = { ...next.fontSize, [field.key]: value as number | boolean }
      break
  }
  return next
}

function clearOverride(
  ov: ThemeOverrides,
  field: EditableField,
  base: BuiltinThemeName,
): ThemeOverrides {
  const next = cloneOverrides(ov)
  switch (field.group) {
    case 'color':
      // Also drop a legacy global value, or reset would leave it in effect.
      delete (next as Record<string, unknown>)[field.key]
      if (next[base]) {
        delete (next[base] as Record<string, unknown>)[field.key]
        pruneEmpty(next, base)
      }
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
    case 'fontSize':
      if (next.fontSize) {
        delete (next.fontSize as Record<string, unknown>)[field.key]
        pruneEmpty(next, 'fontSize')
      }
      break
  }
  return next
}

// A persist instruction the modal routes to the right path: `themeOverrides`
// replaces the whole override object; `setting` is a normal settings patch.
export type FieldPatch =
  { kind: 'overrides'; overrides: ThemeOverrides } | { kind: 'setting'; patch: Partial<Settings> }

export function applyField(
  settings: Settings,
  field: EditableField,
  value: FieldValue,
  base: BuiltinThemeName,
): FieldPatch {
  if (field.group === 'setting') {
    return { kind: 'setting', patch: { [field.key]: value } as Partial<Settings> }
  }
  return { kind: 'overrides', overrides: setOverride(settings.themeOverrides, field, value, base) }
}

export function resetField(
  settings: Settings,
  field: EditableField,
  base: BuiltinThemeName,
): FieldPatch {
  if (field.group === 'setting') {
    const k = field.key as keyof Settings
    return { kind: 'setting', patch: { [k]: defaultSettings[k] } as Partial<Settings> }
  }
  return { kind: 'overrides', overrides: clearOverride(settings.themeOverrides, field, base) }
}

// Global reset clears every theme override back to {}. Setting-backed fields
// (the Images section) are not theme overrides and keep their values; reset
// those individually with per-field reset.
export function resetAllOverrides(): FieldPatch {
  return { kind: 'overrides', overrides: {} }
}

export function anyOverridden(settings: Settings, base: BuiltinThemeName): boolean {
  return FIELDS.some((f) => f.group !== 'setting' && isOverridden(f, settings, base))
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
