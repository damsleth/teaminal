// The conversation tab bar: the message pane's top line in tabs mode
// (src/state/tabs.ts), e.g. ` 1 Ada Byron │ 2 Design Sync ● │ 3 #launch `.
// The active tab is highlighted; tabs 1-9 carry their number key. When the
// tabs don't fit, the active one stays in view and ‹ / › mark hidden ones.

import { Box } from 'ink'
import { Text } from './Text'
import { useMemo } from 'react'
import { activeTabIndex, tabsOn, tabViews, type TabView } from '../state/tabs'
import { fitCells } from './CommandPalette'
import { tabHitRef } from './listHits'
import { useAppState, useTheme } from './StoreContext'

// A label longer than this is cut, so one long name can't push the others
// out of the bar.
const LABEL_MAX = 24

export type TabSegment =
  | { kind: 'tab'; index: number; text: string; marker: string }
  | { kind: 'sep' }
  | { kind: 'more'; text: '‹' | '›' }

const SEP = '│'

// `text` cut to at most `max` terminal cells (wide-character safe, ends in …).
function clip(text: string, max: number): string {
  return Bun.stringWidth(text) <= max ? text : fitCells(text, max).trimEnd()
}

const MARKER = { mention: ' @', unread: ' ●' } as const

// The segments of a bar `width` cells wide around the active tab (-1: the
// first). Tabs are added on both sides of it while they fit.
export function layoutTabBar(views: TabView[], active: number, width: number): TabSegment[] {
  const n = views.length
  if (n === 0 || width <= 0) return []
  const tabs = views.map((v, i) => ({
    num: i < 9 ? `${i + 1} ` : '',
    label: clip(v.label, LABEL_MAX),
    marker: v.unread ? MARKER[v.unread] : '',
  }))
  const cells = (i: number) => {
    const t = tabs[i]!
    return 2 + Bun.stringWidth(t.num + t.label + t.marker)
  }
  const total = (lo: number, hi: number) => {
    let w = (lo > 0 ? 1 : 0) + (hi < n - 1 ? 1 : 0) + (hi - lo)
    for (let i = lo; i <= hi; i++) w += cells(i)
    return w
  }
  const anchor = active >= 0 && active < n ? active : 0
  let lo = anchor
  let hi = anchor
  for (let grew = true; grew;) {
    grew = false
    if (hi < n - 1 && total(lo, hi + 1) <= width) {
      hi++
      grew = true
    }
    if (lo > 0 && total(lo - 1, hi) <= width) {
      lo--
      grew = true
    }
  }
  // The active tab alone is too wide: cut its label, then (a very narrow
  // pane) drop its marker, its number and the ‹ › marks.
  const t = tabs[anchor]!
  let marks = true
  const over = () => total(lo, hi) - (marks ? 0 : (lo > 0 ? 1 : 0) + (hi < n - 1 ? 1 : 0)) - width
  if (over() > 0) t.label = clip(t.label, Math.max(0, Bun.stringWidth(t.label) - over()))
  if (over() > 0) t.marker = ''
  if (over() > 0) t.num = ''
  if (over() > 0) marks = false
  const out: TabSegment[] = []
  if (marks && lo > 0) out.push({ kind: 'more', text: '‹' })
  for (let i = lo; i <= hi; i++) {
    if (i > lo) out.push({ kind: 'sep' })
    const t = tabs[i]!
    out.push({ kind: 'tab', index: i, text: ` ${t.num}${t.label}`, marker: t.marker })
  }
  if (marks && hi < n - 1) out.push({ kind: 'more', text: '›' })
  return out
}

// What the bar shows, as a string so the selector result compares by value
// (tabViews builds new objects on every call). Empty: no bar.
function barKey(s: Parameters<typeof tabViews>[0]): string {
  if (!tabsOn(s) || s.tabs.length === 0) return ''
  return JSON.stringify([activeTabIndex(s), tabViews(s)])
}

// Whether the bar is shown (the pane budgets a row for it).
export function useTabBarShown(): boolean {
  return useAppState((s) => tabsOn(s) && s.tabs.length > 0)
}

export function TabBar({ width }: { width: number }) {
  const key = useAppState(barKey)
  const theme = useTheme()
  const bar = useMemo(() => {
    if (!key) return null
    const [active, views] = JSON.parse(key) as [number, TabView[]]
    return { active, segments: layoutTabBar(views, active, width) }
  }, [key, width])
  if (!bar) return null
  return (
    <Box flexShrink={0} height={1} overflow="hidden">
      {bar.segments.map((seg, i) => {
        if (seg.kind === 'sep' || seg.kind === 'more') {
          return (
            <Text key={`s${i}`} color={theme.mutedText}>
              {seg.kind === 'sep' ? SEP : seg.text}
            </Text>
          )
        }
        const active = seg.index === bar.active
        return (
          <Box key={`t${seg.index}`} ref={tabHitRef(seg.index)} flexShrink={0}>
            <Text
              color={active ? theme.selected : theme.mutedText}
              bold={active && theme.emphasis.selectedBold}
            >
              {seg.text}
              {seg.marker && <Text color={theme.unread}>{seg.marker}</Text>}{' '}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
