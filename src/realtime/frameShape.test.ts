import { describe, expect, test } from 'bun:test'
import { describeFrame, outerKind } from './frameShape'

// Synthetic secrets, fresh per run, so a pass cannot come from a constant
// that happens to match.
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const S = {
  token: `eyJ${rand()}.eyJ${rand()}.${rand()}`,
  thread: `19:${rand()}@thread.v2`,
  address: `kari.${rand()}@example.com`,
  guid: crypto.randomUUID(),
  user: `8:orgid:${crypto.randomUUID()}`,
  body: `Hei Kari, møtet er flyttet ${rand()}`,
  cred: `st=${rand()}&sig=${rand()}`,
  key: `k${rand()}`,
}
const sentinels = Object.values(S)

const payload = {
  [S.key]: S.body,
  eventType: S.token,
  resource: `/v1/users/ME/conversations/${S.thread}/messages/${S.guid}?${S.cred}`,
  resourceData: { content: S.body, from: S.address, userId: S.user },
  [S.guid]: 1,
}

const frames: string[] = [
  `5:3+::${JSON.stringify({ name: S.token, args: [payload] })}`,
  `5:::${JSON.stringify({ name: 'trouter.connected', args: [{ id: S.guid, surl: `https://${S.address}/v4/f/${S.thread}/`, connectparams: { st: S.cred } }] })}`,
  `5:::${JSON.stringify({ name: S.body, args: [S.body] })}`,
  `5:::${JSON.stringify({ name: 'x', args: [{ eventType: 'NewMessage', resource: { path: S.thread } }] })}`,
  `5:::${JSON.stringify({ name: 'x', args: [{ eventType: 'NewMessage', resource: 42 }] })}`,
  `5:::{"name":"${S.token}","args":[{"resource":"${S.thread}"`,
  JSON.stringify({ body: payload }),
  JSON.stringify(payload),
  JSON.stringify({ eventType: 'x', resource: `/chats('${S.thread}')/messages('${S.guid}')` }),
  `{"eventType":"${S.token}","resource":"/chats/${S.thread}"`,
  JSON.stringify([S.body, S.token]),
  `3:::${S.token} ${S.body}`,
  `${S.body} ${S.address} ${S.cred}`,
  `Bearer ${S.token}`,
]

describe('describeFrame', () => {
  test('no sentinel from any field or failure path reaches the output', () => {
    for (const raw of frames) {
      const out = describeFrame(raw, ['new-message'])
      for (const secret of sentinels) {
        expect(out.toLowerCase()).not.toContain(secret.toLowerCase())
      }
    }
  })

  test('shapes keep allowlisted names, keys and segments and nothing else', () => {
    expect(describeFrame(frames[0]!, ['new-message'])).toBe(
      'outer=5 name=other keys=eventType,resource,resourceData,+2 resource=string:/v1/users/me/conversations/:other/messages/:other?:other kinds=new-message',
    )
    expect(describeFrame(frames[1]!)).toBe(
      'outer=5 name=trouter.connected keys=id,surl,connectparams resource=absent kinds=none',
    )
    expect(describeFrame(frames[2]!)).toBe('outer=5 name=other payload=string kinds=none')
    expect(describeFrame(frames[3]!)).toContain('resource=object')
    expect(describeFrame(frames[4]!)).toContain('resource=number')
    expect(describeFrame(frames[5]!)).toBe('outer=5 parse=failed kinds=none')
    expect(describeFrame(frames[6]!)).toContain('keys=eventType,resource,resourceData,+2')
    expect(describeFrame(frames[8]!)).toContain('resource=string:/chats(:other)/messages(:other)')
    expect(describeFrame(frames[9]!)).toBe('outer=json parse=failed kinds=none')
    expect(describeFrame(frames[10]!)).toBe('outer=json payload=array kinds=none')
    expect(describeFrame(frames[11]!)).toBe('outer=3 kinds=none')
    expect(describeFrame(frames[12]!)).toBe('outer=other kinds=none')
  })

  test('short arbitrary path segments become :other', () => {
    const out = describeFrame(
      JSON.stringify({ resource: '/chats/ab/x1/messages/Qz/typing/a/b/c/d' }),
    )
    expect(out).toContain('resource=string:/chats/:other/:other/messages/:other/typing/:other/…')
  })

  test('outer kinds', () => {
    expect(outerKind('1::')).toBe('1::')
    expect(outerKind('2::')).toBe('2::')
    expect(outerKind('3:::x')).toBe('3')
    expect(outerKind('5:1+::{}')).toBe('5')
    expect(outerKind('{"a":1}')).toBe('json')
    expect(outerKind('2::x')).toBe('other')
    expect(outerKind('')).toBe('other')
  })
})
