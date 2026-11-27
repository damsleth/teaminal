import { expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { createAppStore } from '../state/store'
import { BINDINGS, KeybindsModal } from './KeybindsModal'
import { StoreProvider } from './StoreContext'

// Taller-than-pane tables must page, not spill past the modal frame.
test('keybinds table is windowed to the terminal height', () => {
  const store = createAppStore()
  store.set({ modal: { kind: 'keybinds' } })
  const out = renderToString(
    <StoreProvider store={store}>
      <KeybindsModal />
    </StoreProvider>,
    { columns: 60 },
  )
  // eslint-disable-next-line no-control-regex
  const lines = out.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  expect(lines.length).toBeLessThanOrEqual(24)
  expect(out).toMatch(/1-\d+ of \d+ · j\/k u\/d scroll/)
  expect(out).not.toContain('Ctrl+C')
  // Narrow pane: rows truncate instead of wrapping.
  expect(lines.every((l) => l.length <= 60)).toBe(true)
})

test('the split-pane keys are listed', () => {
  const rows = BINDINGS.map((b) => `${b.keys} | ${b.when} | ${b.action}`)
  expect(rows).toContain('v | list | open the chat / channel in the other pane (split)')
  expect(rows).toContain('v | chat / channel | move it to the other pane, pick one here')
  expect(rows).toContain('w | list / chat (split) | switch to the other pane')
  expect(rows).toContain('o | list / chat (split) | close the other pane')
})
