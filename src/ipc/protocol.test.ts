import { describe, expect, test } from 'bun:test'
import { encode, isActionName, LineDecoder, type HostToView, type ViewToHost } from './protocol'

describe('protocol/encode', () => {
  test('appends a newline so the peer can frame', () => {
    const s = encode({ type: 'ack', seq: 7 } satisfies ViewToHost)
    expect(s).toBe('{"type":"ack","seq":7}\n')
  })
})

describe('protocol/LineDecoder', () => {
  test('parses one complete message per line', () => {
    const d = new LineDecoder<HostToView>()
    const msgs = d.push('{"type":"snapshot","seq":1,"state":{}}\n')
    expect(msgs).toEqual([{ type: 'snapshot', seq: 1, state: {} }])
  })

  test('buffers a partial trailing line until the next chunk arrives', () => {
    const d = new LineDecoder<HostToView>()
    const a = d.push('{"type":"snap')
    expect(a).toEqual([])
    const b = d.push('shot","seq":2,"state":null}\n')
    expect(b).toEqual([{ type: 'snapshot', seq: 2, state: null }])
  })

  test('handles multiple messages in a single chunk', () => {
    const d = new LineDecoder<HostToView>()
    const msgs = d.push(
      '{"type":"snapshot","seq":1,"state":{}}\n{"type":"snapshot","seq":2,"state":{}}\n',
    )
    expect(msgs.length).toBe(2)
    expect((msgs[0] as { seq: number }).seq).toBe(1)
    expect((msgs[1] as { seq: number }).seq).toBe(2)
  })

  test('drops malformed lines without throwing', () => {
    const d = new LineDecoder<HostToView>()
    const msgs = d.push('not json\n{"type":"ack","seq":3}\n')
    expect(msgs).toEqual([{ type: 'ack', seq: 3 } as never])
  })
})

describe('protocol/isActionName', () => {
  test('accepts whitelisted names', () => {
    expect(isActionName('setState')).toBe(true)
    expect(isActionName('submitMessage')).toBe(true)
    expect(isActionName('refresh')).toBe(true)
    expect(isActionName('hardRefresh')).toBe(true)
  })

  test('rejects unknown names', () => {
    expect(isActionName('setFocus')).toBe(false)
    expect(isActionName('arbitraryRpc')).toBe(false)
    expect(isActionName('')).toBe(false)
  })
})
