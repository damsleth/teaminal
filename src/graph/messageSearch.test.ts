import { describe, expect, it } from 'bun:test'
import { parseSearchResponse } from './messageSearch'

describe('parseSearchResponse', () => {
  it('flattens hits and strips highlight markers from summaries', () => {
    const json = {
      value: [
        {
          hitsContainers: [
            {
              hits: [
                {
                  summary: 'see the <c0>deploy</c0> notes',
                  resource: {
                    id: 'm1',
                    chatId: '19:abc@unq.gbl.spaces',
                    createdDateTime: '2026-05-29T10:00:00Z',
                    from: { user: { displayName: 'Bjørn' } },
                    body: { content: '<p>see the deploy notes</p>' },
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    expect(parseSearchResponse(json)).toEqual([
      {
        messageId: 'm1',
        chatId: '19:abc@unq.gbl.spaces',
        snippet: 'see the deploy notes',
        createdDateTime: '2026-05-29T10:00:00Z',
        senderDisplayName: 'Bjørn',
      },
    ])
  })

  it('falls back to the body when no summary is present', () => {
    const json = {
      value: [
        { hitsContainers: [{ hits: [{ resource: { id: 'm2', body: { content: '<b>hi</b>' } } }] }] },
      ],
    }
    const hits = parseSearchResponse(json)
    expect(hits[0]!.snippet).toBe('hi')
    expect(hits[0]!.chatId).toBeNull()
  })

  it('skips hits without a message id', () => {
    const json = { value: [{ hitsContainers: [{ hits: [{ summary: 'orphan' }] }] }] }
    expect(parseSearchResponse(json)).toEqual([])
  })

  it('returns empty for missing / malformed shapes', () => {
    expect(parseSearchResponse(null)).toEqual([])
    expect(parseSearchResponse({})).toEqual([])
    expect(parseSearchResponse({ value: [{}] })).toEqual([])
    expect(parseSearchResponse({ value: 'nope' })).toEqual([])
  })
})
