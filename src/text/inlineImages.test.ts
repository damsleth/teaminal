import { describe, expect, it } from 'bun:test'
import { extractInlineImages } from './inlineImages'
import type { ChatMessage } from '../types'

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    createdDateTime: '2026-05-13T10:00:00Z',
    body: { contentType: 'html', content: '' },
    ...partial,
  }
}

describe('extractInlineImages', () => {
  it('extracts pasted inline image from HTML <img itemid>', () => {
    const m = msg({
      body: {
        contentType: 'html',
        content:
          '<p><img alt="photo.png" src="https://graph.microsoft.com/v1.0/chats/chat-1/messages/msg-1/hostedContents/AAA/$value" itemid="AAA"></p>',
      },
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.cacheKey).toBe('msg-1::AAA')
    expect(refs[0]!.isExternal).toBe(false)
    expect(refs[0]!.sourcePath).toContain('/hostedContents/AAA/$value')
    expect(refs[0]!.name).toBe('photo.png')
  })

  it('extracts uploaded image from attachments entry', () => {
    const m = msg({
      attachments: [
        {
          id: 'att-1',
          contentType: 'reference',
          contentUrl:
            'https://graph.microsoft.com/v1.0/sites/x/drives/y/items/z',
          name: 'screenshot.png',
        },
      ],
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.cacheKey).toBe('msg-1::att-1')
    expect(refs[0]!.isExternal).toBe(false)
    expect(refs[0]!.name).toBe('screenshot.png')
  })

  it('extracts GIF from external contentUrl (gif picker)', () => {
    const m = msg({
      attachments: [
        {
          id: 'att-2',
          contentType: 'application/vnd.microsoft.card.animation',
          contentUrl: 'https://media.giphy.com/media/abc/giphy.gif',
          name: null,
        },
      ],
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.cacheKey).toBe('msg-1::att-2')
    expect(refs[0]!.isExternal).toBe(true)
    expect(refs[0]!.sourcePath).toBe('https://media.giphy.com/media/abc/giphy.gif')
    expect(refs[0]!.name).toBe('giphy.gif')
  })

  it('extracts GIF when contentType is image/gif with external URL', () => {
    const m = msg({
      attachments: [
        {
          id: 'att-3',
          contentType: 'image/gif',
          contentUrl: 'https://media.tenor.com/foo.gif',
          name: null,
        },
      ],
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.isExternal).toBe(true)
    expect(refs[0]!.name).toBe('foo.gif')
  })

  it('dedupes when HTML <img itemid> and attachments entry share the id', () => {
    const m = msg({
      body: {
        contentType: 'html',
        content: '<p><img itemid="AAA" src="..."></p>',
      },
      attachments: [
        {
          id: 'AAA',
          contentType: 'image/png',
          contentUrl:
            'https://graph.microsoft.com/v1.0/chats/chat-1/messages/msg-1/hostedContents/AAA/$value',
          name: 'photo.png',
        },
      ],
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.cacheKey).toBe('msg-1::AAA')
    // Attachment is processed first; its name wins.
    expect(refs[0]!.name).toBe('photo.png')
  })

  it('returns [] for messages with no images', () => {
    const m = msg({
      body: { contentType: 'text', content: 'just a text message' },
    })
    expect(extractInlineImages(m)).toEqual([])
  })

  it('ignores non-image attachments', () => {
    const m = msg({
      attachments: [
        {
          id: 'att-pdf',
          contentType: 'application/pdf',
          name: 'doc.pdf',
        },
      ],
    })
    expect(extractInlineImages(m)).toEqual([])
  })

  it('extracts <img> when itemid is missing but src is a hostedContents URL', () => {
    const m = msg({
      body: {
        contentType: 'html',
        content:
          '<img src="https://graph.microsoft.com/v1.0/chats/chat-1/messages/msg-1/hostedContents/BBB/$value">',
      },
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.cacheKey).toBe('msg-1::BBB')
    expect(refs[0]!.isExternal).toBe(false)
  })
})
