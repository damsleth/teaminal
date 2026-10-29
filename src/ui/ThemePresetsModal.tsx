// Theme presets overlay: the built-in themes plus every saved preset, with
// load / save / save as / delete. Opened from Settings → Theme presets and
// from the theme editor (p, or s while a built-in theme is active).
//
// Keys:
//   ↑/k ↓/j      move
//   enter/space   load the selected theme
//   s             save the current look to the active preset (built-in
//                 active: asks for a name, like n)
//   n             save as a new preset (type a name, enter to save)
//   d             delete the selected preset (y to confirm)
//   esc           back to where it was opened from

import { Box } from 'ink'
import { Text } from './Text'
import { useInput } from './useInput'
import type { AppState, Store } from '../state/store'
import { openMenu } from './MenuModal'
import { openThemeEditor } from './ThemeEditorModal'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { inkBorder, modalBg } from './theme'
import {
  activePresetName,
  deleteThemePresetByName,
  loadThemePreset,
  saveThemePresetAs,
  themeChoices,
} from './themePresets'

const CONTENT_W = 52

function pad(s: string): string {
  return s.length >= CONTENT_W ? s : s + ' '.repeat(CONTENT_W - s.length)
}

type PresetsModal = Extract<NonNullable<AppState['modal']>, { kind: 'theme-presets' }>

export function openThemePresets(
  store: Store<AppState>,
  returnTo: PresetsModal['returnTo'],
  prompt: string | null = null,
): void {
  const names = themeChoices().map((c) => c.name)
  const cursor = Math.max(0, names.indexOf(store.get().settings.theme))
  store.set({
    modal: { kind: 'theme-presets', cursor, returnTo, prompt, confirmDelete: false, message: null },
    inputZone: 'menu',
  })
}

export function ThemePresetsModal() {
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const activeTheme = useAppState((s) => s.settings.theme)
  const appearance = useAppState((s) => s.systemAppearance)
  const theme = useTheme()
  const isOpen = modal?.kind === 'theme-presets'
  const choices = isOpen ? themeChoices() : []

  const update = (patch: Partial<PresetsModal>): void => {
    const m = store.get().modal
    if (m?.kind === 'theme-presets') store.set({ modal: { ...m, ...patch } })
  }

  async function saveAs(name: string): Promise<void> {
    const err = await saveThemePresetAs(store, name)
    if (err) return update({ message: err })
    const idx = themeChoices().findIndex((c) => c.name === name.trim())
    update({ prompt: null, message: `saved "${name.trim()}"`, cursor: Math.max(0, idx) })
  }

  useInput(
    (input, key) => {
      const m = store.get().modal
      if (!m || m.kind !== 'theme-presets') return
      const selected = choices[m.cursor]

      // Name prompt owns the keys until it saves or cancels.
      if (m.prompt !== null) {
        if (key.escape) return update({ prompt: null, message: null })
        if (key.return) return void saveAs(m.prompt)
        if (key.backspace || key.delete) return update({ prompt: m.prompt.slice(0, -1) })
        if (input && !key.ctrl && !key.meta && m.prompt.length < 41)
          update({ prompt: m.prompt + input, message: null })
        return
      }

      if (m.confirmDelete) {
        if (input === 'y' && selected && !selected.builtin) {
          void deleteThemePresetByName(store, selected.name).then(() => {
            const n = themeChoices().length
            update({
              confirmDelete: false,
              message: `deleted "${selected.name}"`,
              cursor: Math.min(m.cursor, n - 1),
            })
          })
          return
        }
        return update({ confirmDelete: false, message: null })
      }

      if (key.escape) {
        if (m.returnTo === 'theme-editor') openThemeEditor(store)
        else openMenu(store, ['settings'])
        return
      }
      const ch = input.toLowerCase()
      if (key.upArrow || ch === 'k')
        return update({ cursor: Math.max(0, m.cursor - 1), message: null })
      if (key.downArrow || ch === 'j')
        return update({ cursor: Math.min(choices.length - 1, m.cursor + 1), message: null })
      if (key.return || input === ' ') {
        if (selected) void loadThemePreset(store, selected.name)
        return update({ message: selected ? `loaded "${selected.name}"` : null })
      }
      if (input === 's') {
        const active = activePresetName(store.get())
        if (active) return void saveAs(active)
        return update({ prompt: '', message: 'built-in theme: name the new preset' })
      }
      if (input === 'n') return update({ prompt: '', message: null })
      if (input === 'd') {
        if (!selected || selected.builtin)
          return update({ message: "built-in themes can't be deleted" })
        return update({ confirmDelete: true, message: null })
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen || !modal || modal.kind !== 'theme-presets') return null

  const bg = modalBg(theme)
  const selected = choices[modal.cursor]
  const footer =
    modal.prompt !== null
      ? 'type a name · enter save · esc cancel'
      : modal.confirmDelete
        ? `delete "${selected?.name}"? y confirm · any key cancels`
        : 'enter load · s save · n save as · d delete · esc'

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={inkBorder(theme.borders.modal)}
        borderColor={theme.borderActive}
        backgroundColor={bg}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
        maxWidth="100%"
      >
        <Text bold={theme.emphasis.modalTitleBold} backgroundColor={bg}>
          {pad(
            `Theme presets · active: ${activeTheme === 'auto' ? `auto → ${appearance}` : activeTheme}`,
          )}
        </Text>
        <Text color="gray" backgroundColor={bg}>
          {pad('● = active · saving folds your edits into the preset')}
        </Text>
        <Text backgroundColor={bg}>{pad('')}</Text>
        {choices.map((c, i) => {
          const isSel = i === modal.cursor
          const isActive = c.name === activeTheme
          return (
            <Text key={c.name} backgroundColor={bg}>
              <Text color={isSel ? theme.selected : 'gray'} backgroundColor={bg}>
                {isSel ? '> ' : '  '}
              </Text>
              <Text color={theme.warnText} backgroundColor={bg}>
                {isActive ? '● ' : '  '}
              </Text>
              <Text
                color={isSel ? theme.selected : theme.text}
                bold={isSel && theme.emphasis.selectedBold}
                backgroundColor={bg}
              >
                {c.name}
              </Text>
              <Text color="gray" backgroundColor={bg}>
                {pad(
                  c.name === 'auto'
                    ? `  light or dark to match the terminal (${appearance})`
                    : c.builtin
                      ? '  built-in'
                      : '',
                ).slice(0, CONTENT_W - 4 - c.name.length)}
              </Text>
            </Text>
          )
        })}
        {modal.prompt !== null && (
          <Text backgroundColor={bg}>
            <Text color={theme.text} backgroundColor={bg}>
              {'Save as: '}
            </Text>
            <Text color={theme.selected} backgroundColor={bg}>
              {modal.prompt}
            </Text>
            <Text color="gray" backgroundColor={bg}>
              {pad('_').slice(0, Math.max(1, CONTENT_W - 9 - modal.prompt.length))}
            </Text>
          </Text>
        )}
        <Text backgroundColor={bg}>{pad('')}</Text>
        {modal.message && (
          <Text color={theme.infoText} backgroundColor={bg}>
            {pad(modal.message)}
          </Text>
        )}
        <Text color="gray" backgroundColor={bg}>
          {pad(footer)}
        </Text>
      </Box>
    </Box>
  )
}
