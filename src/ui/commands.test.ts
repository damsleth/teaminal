import { expect, test } from 'bun:test'
import { applySeededState } from '../state/seedFixtures'
import { createAppStore } from '../state/store'
import { buildCommands, filterCommands, fuzzyScore, type CommandRunners } from './commands'
import { fitCells } from './CommandPalette'
import type { MenuItem } from './menu'

function setup() {
  const store = createAppStore()
  applySeededState(store)
  const ran: string[] = []
  const runners: CommandRunners = {
    runMenuItem: (item: MenuItem, path: string[]) =>
      ran.push(`menu:${[...path, item.id].join('/')}`),
    setPresence: (c) => ran.push(`presence:${c}`),
    focusChat: (id) => ran.push(`chat:${id}`),
    focusChannel: (t, c) => ran.push(`channel:${t}:${c}`),
    keyActions: [{ id: 'refresh', title: 'Refresh', keys: 'r', run: () => ran.push('refresh') }],
  }
  return { commands: buildCommands(store.get(), runners), ran, store }
}

test('commands cover menu items with their values, key actions and chats', () => {
  const { commands } = setup()
  const theme = commands.find((c) => c.id === 'menu:settings/theme')!
  expect(theme.title).toBe('Settings › Theme')
  expect(theme.detail).toBe('auto')
  expect(commands.find((c) => c.id === 'menu:settings/headerBar/header-app')?.title).toBe(
    'Settings › Header elements › App name',
  )
  expect(commands.some((c) => c.id === 'key:refresh')).toBe(true)
  expect(commands.some((c) => c.title === 'Go to Ada Byron')).toBe(true)
  // Group headings, Resume and hidden items (Enter sends, outside kitty) are not commands.
  expect(commands.some((c) => c.id.includes('heading:'))).toBe(false)
  expect(commands.some((c) => c.id === 'menu:resume')).toBe(false)
  expect(commands.some((c) => c.id === 'menu:settings/enterSends')).toBe(false)
})

test('running a command goes through the same runners as the menu and list', () => {
  const { commands, ran } = setup()
  commands.find((c) => c.id === 'menu:settings/centerDateMarkers')!.run()
  commands.find((c) => c.title === 'Go to Ada Byron')!.run()
  expect(ran[0]).toBe('menu:settings/centerDateMarkers')
  expect(ran[1]).toMatch(/^chat:/)
})

test('fuzzy matching: in-order characters, word starts and runs rank higher', () => {
  expect(fuzzyScore('cdt', 'Center dates')).not.toBeNull()
  expect(fuzzyScore('xyz', 'Center dates')).toBeNull()
  expect(fuzzyScore('cen', 'Center dates')!).toBeGreaterThan(fuzzyScore('cen', 'Scenery')!)
  const { commands } = setup()
  const top = filterCommands(commands, 'center dates')[0]!
  expect(top.id).toBe('menu:settings/centerDateMarkers')
  expect(filterCommands(commands, '')).toHaveLength(commands.length)
})

test('a query that names an item ranks it above chats that merely contain it', () => {
  const run = () => {}
  const commands = [
    { id: 'chat:park', title: 'Go to Theme park', group: 'Chats', run },
    { id: 'menu:settings/theme', title: 'Settings › Theme', group: 'Settings', run },
  ]
  expect(filterCommands(commands, 'theme')[0]!.id).toBe('menu:settings/theme')
})

test('fitCells pads and cuts by terminal cells, never splitting a character', () => {
  expect(fitCells('ab', 4)).toBe('ab  ')
  expect(fitCells('漢字漢字', 5)).toBe('漢字…')
  expect(Bun.stringWidth(fitCells('👍👍👍', 4))).toBe(4)
})

test('presence commands set the picked presence', () => {
  const { commands, ran } = setup()
  commands.find((c) => c.id === 'presence:Busy')?.run()
  expect(ran).toEqual(['presence:Busy'])
})
