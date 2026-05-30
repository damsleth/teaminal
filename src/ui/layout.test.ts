import { describe, expect, test } from 'bun:test'
import { computeLayout } from './layout'

describe('computeLayout', () => {
  describe('normal terminal (cols=120, rows=40)', () => {
    const base = {
      cols: 120,
      rows: 40,
      draftLines: 1,
      quoteRows: 0,
      chatListWidth: null,
      composerHeight: null,
    }

    test('auto chat list width is ~28% of cols, clamped to 24-44', () => {
      const { chatListWidth } = computeLayout(base)
      // round(120 * 0.28) = round(33.6) = 34, within [24,44] and [12, min(60,80)]
      expect(chatListWidth).toBe(34)
    })

    test('auto composer height is draftLines + quoteRows + 2, min 3', () => {
      const { composerHeight } = computeLayout(base)
      // 1 + 0 + 2 = 3, clamp(3, 3, min(10, floor(40/3)=13)) = 3
      expect(composerHeight).toBe(3)
    })

    test('auto composer height grows with draft lines', () => {
      const { composerHeight } = computeLayout({ ...base, draftLines: 4 })
      // 4 + 0 + 2 = 6
      expect(composerHeight).toBe(6)
    })

    test('auto composer height is capped at 8 by the inner clamp', () => {
      const { composerHeight } = computeLayout({ ...base, draftLines: 10 })
      // auto = clamp(10 + 0 + 2, 3, 8) = 8; upper bound = min(10, 13) = 10
      expect(composerHeight).toBe(8)
    })
  })

  describe('narrow terminal (cols=70, rows=30)', () => {
    const base = {
      cols: 70,
      rows: 30,
      draftLines: 1,
      quoteRows: 0,
      chatListWidth: null,
      composerHeight: null,
    }

    test('auto chat list width is clamped against cols-40', () => {
      // round(70 * 0.28) = round(19.6) = 20; lo=12, hi=min(60,30)=30 → clamp(20,12,30)=20
      // But autoChatListWidth = clamp(20, 24, 44) = 24
      // resolvedChatListWidth = clamp(24, 12, 30) = 24
      const { chatListWidth } = computeLayout(base)
      expect(chatListWidth).toBe(24)
    })

    test('composer height upper bound respects rows/3', () => {
      // hi = min(10, floor(30/3)=10) = 10
      const { composerHeight } = computeLayout({ ...base, draftLines: 6 })
      // auto = clamp(6 + 0 + 2, 3, 8) = 8; resolve = clamp(8, 3, 10) = 8
      expect(composerHeight).toBe(8)
    })
  })

  describe('tiny terminal (cols=45, rows=12)', () => {
    const base = {
      cols: 45,
      rows: 12,
      draftLines: 1,
      quoteRows: 0,
      chatListWidth: null,
      composerHeight: null,
    }

    test('chat list never goes below hard floor 12', () => {
      // round(45 * 0.28) = round(12.6) = 13; autoChatListWidth = clamp(13,24,44)=24
      // hi = max(12, min(60, 45-40)) = max(12, 5) = 12
      // resolvedChatListWidth = clamp(24, 12, 12) = 12
      const { chatListWidth } = computeLayout(base)
      expect(chatListWidth).toBeGreaterThanOrEqual(12)
    })

    test('composer height respects tight row budget', () => {
      // hi = max(3, min(10, floor(12/3)=4)) = max(3, 4) = 4
      // auto = clamp(1+0+2, 3, 8) = 3; resolve = clamp(3, 3, 4) = 3
      const { composerHeight } = computeLayout(base)
      expect(composerHeight).toBeGreaterThanOrEqual(3)
      expect(composerHeight).toBeLessThanOrEqual(4)
    })

    test('result values are always positive integers', () => {
      const result = computeLayout(base)
      expect(result.chatListWidth).toBeGreaterThan(0)
      expect(result.composerHeight).toBeGreaterThan(0)
    })
  })

  describe('explicit overrides', () => {
    const base = { cols: 120, rows: 40, draftLines: 1, quoteRows: 0 }

    test('explicit chatListWidth overrides auto', () => {
      const { chatListWidth } = computeLayout({ ...base, chatListWidth: 40, composerHeight: null })
      expect(chatListWidth).toBe(40)
    })

    test('explicit composerHeight overrides auto', () => {
      const { composerHeight } = computeLayout({ ...base, chatListWidth: null, composerHeight: 7 })
      expect(composerHeight).toBe(7)
    })

    test('explicit chatListWidth is still clamped to valid range', () => {
      // max is min(60, 120-40)=60; requesting 100 → clamped to 60
      const { chatListWidth } = computeLayout({ ...base, chatListWidth: 100, composerHeight: null })
      expect(chatListWidth).toBe(60)
    })

    test('explicit composerHeight is still clamped to valid range', () => {
      // hi = min(10, floor(40/3)=13) = 10; requesting 15 → clamped to 10
      const { composerHeight } = computeLayout({ ...base, chatListWidth: null, composerHeight: 15 })
      expect(composerHeight).toBe(10)
    })

    test('explicit chatListWidth below floor is raised to floor', () => {
      const { chatListWidth } = computeLayout({ ...base, chatListWidth: 5, composerHeight: null })
      expect(chatListWidth).toBe(12)
    })

    test('explicit composerHeight below floor is raised to floor', () => {
      const { composerHeight } = computeLayout({ ...base, chatListWidth: null, composerHeight: 1 })
      expect(composerHeight).toBe(3)
    })
  })

  describe('quoteRows', () => {
    test('quoteRows increases auto composer height', () => {
      const { composerHeight } = computeLayout({
        cols: 120,
        rows: 40,
        draftLines: 1,
        quoteRows: 2,
        chatListWidth: null,
        composerHeight: null,
      })
      // auto = clamp(1+2+2, 3, 8) = 5
      expect(composerHeight).toBe(5)
    })
  })
})
