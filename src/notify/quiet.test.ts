import { describe, expect, test } from 'bun:test'
import { decideQuiet, isWithinQuietHours, parseClock } from './quiet'
import type { AppState } from '../state/store'

function settings(overrides: Record<string, unknown> = {}): AppState['settings'] {
  return {
    showPresenceInList: true,
    useTeamsPresence: true,
    activeAccount: null,
    accounts: [],
    ...overrides,
  } as unknown as AppState['settings']
}

function ctx(overrides: {
  conv?: string
  focus?: AppState['focus']
  presenceActivity?: string
  settings?: Record<string, unknown>
  terminalFocused?: boolean
  now?: Date
}) {
  return {
    conv: (overrides.conv ?? 'chat:c1') as `chat:${string}`,
    now: overrides.now ?? new Date('2026-05-05T12:00:00Z'),
    terminalFocused: overrides.terminalFocused ?? false,
    state: {
      focus: overrides.focus ?? { kind: 'list' as const },
      myPresence: overrides.presenceActivity
        ? ({
            id: 'me',
            availability: 'Available',
            activity: overrides.presenceActivity,
          } as unknown as AppState['myPresence'])
        : undefined,
      settings: settings(overrides.settings),
    },
  }
}

describe('parseClock', () => {
  test('valid HH:MM', () => {
    expect(parseClock('22:30')).toBe(22 * 60 + 30)
    expect(parseClock('00:00')).toBe(0)
    expect(parseClock('23:59')).toBe(23 * 60 + 59)
  })
  test('rejects malformed input', () => {
    expect(parseClock('25:00')).toBeNull()
    expect(parseClock('22')).toBeNull()
    expect(parseClock(undefined)).toBeNull()
    expect(parseClock(null)).toBeNull()
    expect(parseClock('')).toBeNull()
  })
})

describe('isWithinQuietHours', () => {
  test('non-wrapping window', () => {
    const at = (h: number, m = 0) => new Date(2026, 4, 5, h, m)
    expect(isWithinQuietHours(at(13), '12:00', '14:00')).toBe(true)
    expect(isWithinQuietHours(at(11, 59), '12:00', '14:00')).toBe(false)
    expect(isWithinQuietHours(at(14, 0), '12:00', '14:00')).toBe(false)
  })

  test('wraps midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 4, 5, h, m)
    expect(isWithinQuietHours(at(23), '22:00', '07:30')).toBe(true)
    expect(isWithinQuietHours(at(2), '22:00', '07:30')).toBe(true)
    expect(isWithinQuietHours(at(8), '22:00', '07:30')).toBe(false)
  })

  test('zero-width window matches nothing', () => {
    expect(isWithinQuietHours(new Date(), '12:00', '12:00')).toBe(false)
  })

  test('malformed times are treated as no quiet hours', () => {
    expect(isWithinQuietHours(new Date(), 'bogus', '14:00')).toBe(false)
  })
})

describe('decideQuiet', () => {
  test('default decision is normal', () => {
    expect(decideQuiet(ctx({}))).toBe('normal')
  })

  test('manual mute downgrades to bell-only', () => {
    expect(decideQuiet(ctx({ settings: { notifyMuted: true } }))).toBe('bell-only')
  })

  test('active conv with terminal focus drops the banner', () => {
    expect(
      decideQuiet(
        ctx({
          conv: 'chat:c1',
          focus: { kind: 'chat', chatId: 'c1' },
          terminalFocused: true,
        }),
      ),
    ).toBe('bell-only')
  })

  test('an open thread is an active conv too', () => {
    expect(
      decideQuiet(
        ctx({
          conv: 'thread:t1:ch1:r1',
          focus: { kind: 'thread', teamId: 't1', channelId: 'ch1', rootId: 'r1' },
          terminalFocused: true,
        }),
      ),
    ).toBe('bell-only')
  })

  test('notifyActiveBanner overrides active-conv suppression', () => {
    expect(
      decideQuiet(
        ctx({
          conv: 'chat:c1',
          focus: { kind: 'chat', chatId: 'c1' },
          terminalFocused: true,
          settings: { notifyActiveBanner: true },
        }),
      ),
    ).toBe('normal')
  })

  test('Presenting suppresses the banner, keeps the bell', () => {
    expect(decideQuiet(ctx({ presenceActivity: 'Presenting' }))).toBe('bell-only')
  })

  test('DoNotDisturb suppresses the banner, keeps the bell', () => {
    expect(decideQuiet(ctx({ presenceActivity: 'DoNotDisturb' }))).toBe('bell-only')
  })

  test('quiet hours suppress the banner', () => {
    const result = decideQuiet(
      ctx({
        now: new Date(2026, 4, 5, 23, 0),
        settings: { quietHoursStart: '22:00', quietHoursEnd: '07:30' },
      }),
    )
    expect(result).toBe('bell-only')
  })

  test('quiet hours outside the window allow normal notify', () => {
    expect(
      decideQuiet(
        ctx({
          now: new Date(2026, 4, 5, 12, 0),
          settings: { quietHoursStart: '22:00', quietHoursEnd: '07:30' },
        }),
      ),
    ).toBe('normal')
  })
})

// Split panes: visibleConvs lists the conversations on screen (the active
// pane, and the passive pane while it is shown) and replaces state.focus.
describe('decideQuiet with visibleConvs', () => {
  const ACTIVE = 'chat:c1'
  const PASSIVE_THREAD = 'thread:t1:ch1:r1'
  const visible = (over: Parameters<typeof ctx>[0], visibleConvs: string[]) => ({
    ...ctx({ focus: { kind: 'chat', chatId: 'c1' }, ...over }),
    visibleConvs,
  })

  test('a mention in the passive pane (a thread) is bell-only under defaults', () => {
    const c = visible({ conv: PASSIVE_THREAD, terminalFocused: true }, [ACTIVE, PASSIVE_THREAD])
    expect(decideQuiet(c)).toBe('bell-only')
    // ...and in the active pane.
    expect(decideQuiet({ ...c, conv: ACTIVE })).toBe('bell-only')
  })

  test('a hidden passive pane is not on screen: banner as for any other chat', () => {
    expect(decideQuiet(visible({ conv: PASSIVE_THREAD, terminalFocused: true }, [ACTIVE]))).toBe(
      'normal',
    )
  })

  test('visibleConvs replaces state.focus', () => {
    // state.focus names c1, but nothing is on screen.
    expect(decideQuiet(visible({ conv: ACTIVE, terminalFocused: true }, []))).toBe('normal')
  })

  test('active banner / bell overrides apply to the passive pane', () => {
    const both = [ACTIVE, PASSIVE_THREAD]
    expect(
      decideQuiet(
        visible(
          { conv: PASSIVE_THREAD, terminalFocused: true, settings: { notifyActiveBanner: true } },
          both,
        ),
      ),
    ).toBe('normal')
    expect(
      decideQuiet(
        visible(
          { conv: PASSIVE_THREAD, terminalFocused: true, settings: { notifyActiveBell: false } },
          both,
        ),
      ),
    ).toBe('silent')
  })

  test('terminal blur keeps the normal path, then mute, presence and quiet hours apply', () => {
    const both = [ACTIVE, PASSIVE_THREAD]
    expect(decideQuiet(visible({ conv: PASSIVE_THREAD, terminalFocused: false }, both))).toBe(
      'normal',
    )
    expect(
      decideQuiet(
        visible(
          { conv: PASSIVE_THREAD, terminalFocused: true, settings: { notifyMuted: true } },
          both,
        ),
      ),
    ).toBe('bell-only')
    expect(
      decideQuiet(
        visible(
          { conv: PASSIVE_THREAD, terminalFocused: false, presenceActivity: 'DoNotDisturb' },
          both,
        ),
      ),
    ).toBe('bell-only')
    expect(
      decideQuiet(
        visible(
          {
            conv: PASSIVE_THREAD,
            terminalFocused: false,
            now: new Date(2026, 4, 5, 23, 0),
            settings: { quietHoursStart: '22:00', quietHoursEnd: '07:30' },
          },
          both,
        ),
      ),
    ).toBe('bell-only')
  })
})
