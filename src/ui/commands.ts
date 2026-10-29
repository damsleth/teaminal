// The command palette's commands, built from what the app already has so
// it can't drift from it: every actionable menu item (run exactly as the
// menu runs it), every chat and channel, and the global key actions.
// A future context menu can draw from the same list.

import { buildSelectableList } from '../state/selectables'
import type { AppState } from '../state/store'
import { renderQuietHoursValue, renderSettingValue, ROOT_MENU, type MenuItem } from './menu'

export type Command = {
  id: string
  title: string
  // Shown dim beside the title: the group, and a current value / key.
  group: string
  detail?: string
  run: () => void
}

// What running a command needs, supplied by the palette component.
export type CommandRunners = {
  runMenuItem: (item: MenuItem, path: string[]) => void
  focusChat: (chatId: string) => void
  focusChannel: (teamId: string, channelId: string) => void
  keyActions: { id: string; title: string; keys: string; run: () => void }[]
}

export function buildCommands(state: AppState, runners: CommandRunners): Command[] {
  const commands: Command[] = []

  // Menu items, depth-first, titled by their path ("Settings › Theme").
  const walk = (items: MenuItem[], path: string[], titles: string[]): void => {
    for (const item of items) {
      if (item.disabled || item.hidden?.()) continue
      if (item.action.kind === 'submenu') {
        walk(item.children ?? [], [...path, item.id], [...titles, item.label])
        continue
      }
      if (item.action.kind === 'resume' || item.action.kind === 'noop') continue
      commands.push({
        id: `menu:${[...path, item.id].join('/')}`,
        title: [...titles, item.label].join(' › '),
        group: titles[0] ?? 'Menu',
        detail: menuItemValue(item, state),
        run: () => runners.runMenuItem(item, path),
      })
    }
  }
  walk(ROOT_MENU, [], [])

  for (const action of runners.keyActions) {
    commands.push({
      id: `key:${action.id}`,
      title: action.title,
      group: 'Keys',
      detail: action.keys,
      run: action.run,
    })
  }

  // Every chat and channel, ignoring collapsed sections and the section cap.
  const items = buildSelectableList({
    me: state.me,
    chats: state.chats,
    teams: state.teams,
    channelsByTeam: state.channelsByTeam,
    nameByUserId: state.nameByUserId,
    settings: {
      chatListGroupByType: false,
      chatListSectionCap: false,
      chatListCollapsedSections: {},
    },
  })
  for (const item of items) {
    if (item.kind === 'chat') {
      const chatId = item.chat.id
      commands.push({
        id: `chat:${chatId}`,
        title: `Go to ${item.label}`,
        group: 'Chats',
        run: () => runners.focusChat(chatId),
      })
    } else if (item.kind === 'channel') {
      const { team, channel } = item
      commands.push({
        id: `channel:${team.id}:${channel.id}`,
        title: `Go to ${team.displayName} › ${channel.displayName}`,
        group: 'Channels',
        run: () => runners.focusChannel(team.id, channel.id),
      })
    }
  }
  return commands
}

function menuItemValue(item: MenuItem, state: AppState): string | undefined {
  const s = state.settings
  switch (item.action.kind) {
    case 'toggle-setting':
      return renderSettingValue(item.action.key, s[item.action.key])
    case 'toggle-header-element':
      return s.headerElements[item.action.key] ? 'on' : 'off'
    case 'cycle-quiet-hours':
      return renderQuietHoursValue(s.quietHoursStart, s.quietHoursEnd)
    default:
      return item.hint
  }
}

// Fuzzy match: the query's characters in order (case-insensitive), scored
// higher for matches at word starts and in runs. null = no match.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at === -1) return null
    score += 1
    if (at === prev + 1) score += 5
    if (at === 0 || /[\s›:/(-]/.test(t[at - 1]!)) score += 8
    prev = at
    ti = at + 1
  }
  // Shorter titles win ties.
  return score - t.length / 100
}

// Commands matching `query`, best first; all of them, in order, when empty.
export function filterCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) return commands
  return commands
    .map((c, i) => ({ c, i, score: fuzzyScore(query, `${c.title} ${c.group}`) }))
    .filter((m): m is { c: Command; i: number; score: number } => m.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((m) => m.c)
}
