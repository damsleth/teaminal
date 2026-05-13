import { describe, expect, test } from 'bun:test'
import { findRootQuote } from './Composer'
import type { ChatMessage } from '../types'

const ROOT_FOCUS = {
  kind: 'thread' as const,
  teamId: 'T1',
  channelId: 'C1',
  rootId: 'R1',
}

const ROOT: ChatMessage = {
  id: 'R1',
  createdDateTime: '2026-05-05T00:00:00Z',
  body: { contentType: 'text', content: 'Hello, this is the root post.' },
  from: { user: { id: 'u1', displayName: 'Carl Joakim Damsleth' } },
}

describe('findRootQuote', () => {
  test('returns null when the channel cache has no root', () => {
    expect(findRootQuote(ROOT_FOCUS, {})).toBeNull()
    expect(findRootQuote(ROOT_FOCUS, { 'channel:T1:C1': [] })).toBeNull()
  })

  test('returns sender short name and trimmed body for plain text', () => {
    const out = findRootQuote(ROOT_FOCUS, { 'channel:T1:C1': [ROOT] })
    expect(out).toEqual({
      sender: 'Carl Joakim',
      preview: 'Hello, this is the root post.',
    })
  })

  test('truncates long bodies', () => {
    const long = 'x'.repeat(200)
    const root: ChatMessage = { ...ROOT, body: { contentType: 'text', content: long } }
    const out = findRootQuote(ROOT_FOCUS, { 'channel:T1:C1': [root] })
    expect(out?.preview.endsWith('…')).toBe(true)
    expect(out!.preview.length).toBe(80)
  })

  test('renders html bodies through htmlToText', () => {
    const html = '<p>Hello <b>world</b></p>'
    const root: ChatMessage = { ...ROOT, body: { contentType: 'html', content: html } }
    const out = findRootQuote(ROOT_FOCUS, { 'channel:T1:C1': [root] })
    expect(out?.preview).toContain('Hello')
    expect(out?.preview).toContain('world')
    expect(out?.preview).not.toContain('<b>')
  })
})
