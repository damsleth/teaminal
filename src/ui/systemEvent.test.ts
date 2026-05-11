import { describe, expect, test } from 'bun:test'
import { describeSystemEvent, formatIsoDuration } from './systemEvent'
import type { ChatMessage } from '../types'

const sysMsg = (eventDetail?: ChatMessage['eventDetail']): ChatMessage => ({
  id: 'm1',
  createdDateTime: '2026-05-05T20:17:00Z',
  body: { contentType: 'text', content: '' },
  messageType: 'systemEventMessage',
  eventDetail,
})

describe('describeSystemEvent', () => {
  test('returns null for non-system messages', () => {
    expect(
      describeSystemEvent({
        id: 'x',
        createdDateTime: '',
        body: { contentType: 'text', content: 'hi' },
        messageType: 'message',
      }),
    ).toBeNull()
  })

  test('returns null when eventDetail is missing entirely', () => {
    expect(describeSystemEvent(sysMsg(undefined))).toBeNull()
    expect(describeSystemEvent(sysMsg(null))).toBeNull()
  })

  test('returns null for unknown subtypes', () => {
    expect(
      describeSystemEvent(
        sysMsg({ '@odata.type': '#microsoft.graph.somethingNewEventMessageDetail' }),
      ),
    ).toBeNull()
  })

  test('chatCreated → "chat created"', () => {
    expect(
      describeSystemEvent(
        sysMsg({ '@odata.type': '#microsoft.graph.chatCreatedEventMessageDetail' }),
      ),
    ).toBe('chat created')
  })

  test('membersAdded with initiator and member name', () => {
    const out = describeSystemEvent(
      sysMsg({
        '@odata.type': '#microsoft.graph.membersAddedEventMessageDetail',
        initiator: { user: { id: 'u1', displayName: 'Carl' } },
        members: [{ id: 'u2', displayName: 'Nina' }],
      }),
    )
    expect(out).toBe('Carl added Nina')
  })

  test('membersAdded without initiator falls back to "joined"', () => {
    const out = describeSystemEvent(
      sysMsg({
        '@odata.type': '#microsoft.graph.membersAddedEventMessageDetail',
        members: [{ id: 'u2', displayName: 'Nina' }],
      }),
    )
    expect(out).toBe('Nina joined')
  })

  test('membersRemoved with initiator', () => {
    const out = describeSystemEvent(
      sysMsg({
        '@odata.type': '#microsoft.graph.membersDeletedEventMessageDetail',
        initiator: { user: { id: 'u1', displayName: 'Carl' } },
        members: [{ id: 'u2', displayName: 'Nina' }],
      }),
    )
    expect(out).toBe('Carl removed Nina')
  })

  test('chatRenamed with topic and initiator', () => {
    const out = describeSystemEvent(
      sysMsg({
        '@odata.type': '#microsoft.graph.chatRenamedEventMessageDetail',
        initiator: { user: { id: 'u1', displayName: 'Carl' } },
        topic: 'Project Foo',
      }),
    )
    expect(out).toBe('Carl renamed the chat to "Project Foo"')
  })

  test('chatRenamed without topic returns null', () => {
    const out = describeSystemEvent(
      sysMsg({
        '@odata.type': '#microsoft.graph.chatRenamedEventMessageDetail',
        topic: '',
      }),
    )
    expect(out).toBeNull()
  })

  test('callEnded with duration formats the time', () => {
    const out = describeSystemEvent(
      sysMsg({
        '@odata.type': '#microsoft.graph.callEndedEventMessageDetail',
        callDuration: 'PT1H2M3S',
      }),
    )
    expect(out).toBe('Call ended (1h 2m)')
  })

  test('callEnded without duration falls back to bare label', () => {
    const out = describeSystemEvent(
      sysMsg({ '@odata.type': '#microsoft.graph.callEndedEventMessageDetail' }),
    )
    expect(out).toBe('Call ended')
  })

  test('membersAdded with several members lists the first two', () => {
    const out = describeSystemEvent(
      sysMsg({
        '@odata.type': '#microsoft.graph.membersAddedEventMessageDetail',
        initiator: { user: { id: 'u1', displayName: 'Carl' } },
        members: [
          { id: 'u2', displayName: 'Nina' },
          { id: 'u3', displayName: 'Ola' },
          { id: 'u4', displayName: 'Bea' },
        ],
      }),
    )
    expect(out).toBe('Carl added Nina, Ola and 1 other(s)')
  })
})

describe('formatIsoDuration', () => {
  test('renders hours + minutes', () => {
    expect(formatIsoDuration('PT1H30M')).toBe('1h 30m')
  })
  test('renders hours only when minutes are zero', () => {
    expect(formatIsoDuration('PT2H')).toBe('2h')
  })
  test('renders minutes + seconds for short durations', () => {
    expect(formatIsoDuration('PT2M30S')).toBe('2m 30s')
  })
  test('renders minutes only when above 5', () => {
    expect(formatIsoDuration('PT12M')).toBe('12m')
  })
  test('renders seconds only when no minutes', () => {
    expect(formatIsoDuration('PT45S')).toBe('45s')
  })
  test('passes through unrecognized strings', () => {
    expect(formatIsoDuration('something')).toBe('something')
  })
})
