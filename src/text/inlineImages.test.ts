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
          contentUrl: 'https://graph.microsoft.com/v1.0/sites/x/drives/y/items/z',
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

  it('routes SharePoint reference attachments through the Graph shares API', () => {
    const contentUrl =
      'https://softwareone-my.sharepoint.com/personal/user_example_com/Documents/Microsoft%20Teams%20Chat%20Files/Screenshot%202026-05-27%20at%2012.40.30.png'
    const m = msg({
      attachments: [
        {
          id: 'att-sp',
          contentType: 'reference',
          contentUrl,
          name: 'Screenshot 2026-05-27 at 12.40.30.png',
        },
      ],
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    // Never the unauthenticated external path — SharePoint 403s without auth.
    expect(refs[0]!.isExternal).toBe(false)
    // Graph "encoded sharing URL" share id: u! + base64url of the contentUrl.
    const b64 = Buffer.from(contentUrl, 'utf8')
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\//g, '_')
      .replace(/\+/g, '-')
    expect(refs[0]!.sourcePath).toBe(`/shares/u!${b64}/driveItem/content`)
    // Original URL preserved for open-in-browser (the only route when the
    // Graph fetch 403s on cross-tenant federated chats).
    expect(refs[0]!.openUrl).toBe(contentUrl)
    expect(refs[0]!.name).toBe('Screenshot 2026-05-27 at 12.40.30.png')
  })

  it('infers the name from the SharePoint URL when the attachment has none', () => {
    const m = msg({
      attachments: [
        {
          id: 'att-sp2',
          contentType: 'reference',
          contentUrl: 'https://contoso-my.sharepoint.com/personal/u/Documents/pic.png',
          name: null,
        },
      ],
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.name).toBe('pic.png')
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

  it('ignores emoji rendered as <img alt> (chatsvc emoji), not a fetchable image', () => {
    const m = msg({
      body: {
        contentType: 'html',
        content: '<p>oops <img alt="😕" itemid="emoji-1"> done</p>',
      },
    })
    expect(extractInlineImages(m)).toEqual([])
  })

  it('skips hostedContents images when chatId is empty and no object id', () => {
    const m = msg({
      chatId: undefined,
      body: {
        contentType: 'html',
        content: '<p><img alt="bilde" itemid="AAA"></p>',
      },
    })
    // No chatId and "AAA" isn't a raw asm object id → nothing fetchable, skip.
    expect(extractInlineImages(m)).toEqual([])
  })

  it('carries the asm object id from <img itemid> for asyncgw retrieval', () => {
    const m = msg({
      body: {
        contentType: 'html',
        content:
          '<img alt="bilde" itemid="0-wch-d2-eb9648399c14133f85ce9b9629d25f90" src="https://graph.microsoft.com/v1.0/chats/chat-1/messages/msg-1/hostedContents/AAA/$value">',
      },
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.objectId).toBe('0-wch-d2-eb9648399c14133f85ce9b9629d25f90')
    expect(refs[0]!.isExternal).toBe(false)
  })

  it('regression: prefers the src hostedContents id over a raw-asm-id itemid (cross-tenant 1:1)', () => {
    // Real shape from an external 1:1 chat: itemid is the raw asm object id,
    // while the src URL carries the actual (base64, x_-prefixed) hostedContents
    // id. Building the Graph path from the itemid 404s; the src id is
    // authoritative.
    const rawId = '0-nch-d3-213cc7419f173ab899d8a806b77f85ed'
    const b64 = Buffer.from(
      `id=x_${rawId},type=1,url=https://eu-api.asm.skype.com/v1/objects/${rawId}/views/imgo`,
    ).toString('base64')
    const m = msg({
      body: {
        contentType: 'html',
        content: `<p><img src="https://graph.microsoft.com/v1.0/chats/chat-1/messages/msg-1/hostedContents/${encodeURIComponent(b64)}/$value" width="534" height="176" alt="image" itemid="${rawId}"></p>`,
      },
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.sourcePath).toContain(`/hostedContents/${encodeURIComponent(b64)}/$value`)
    expect(refs[0]!.sourcePath).not.toContain(`/hostedContents/${rawId}/`)
    expect(refs[0]!.cacheKey).toBe(`msg-1::${b64}`)
    // The raw object id still rides along for the asyncgw fallback.
    expect(refs[0]!.objectId).toBe(rawId)
    expect(refs[0]!.region).toBe('emea')
  })

  it('still yields an asyncgw-fetchable ref when chatId is empty but an object id is present', () => {
    const m = msg({
      chatId: undefined,
      body: {
        contentType: 'html',
        content: '<p><img alt="bilde" itemid="0-wch-d2-eb9648399c14133f85ce9b9629d25f90"></p>',
      },
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.objectId).toBe('0-wch-d2-eb9648399c14133f85ce9b9629d25f90')
    expect(refs[0]!.sourcePath).toBe('') // no Graph path; asyncgw-only
    expect(refs[0]!.isExternal).toBe(false)
  })

  it('extracts the object id from a base64 hostedContents id', () => {
    const objectUrl = 'https://na-api.asm.skype.com/v1/objects/0-na-d3-abc123def456/views/imgo'
    const b64 = Buffer.from(`id=,type=1,url=${objectUrl}`).toString('base64')
    const m = msg({
      body: {
        contentType: 'html',
        content: `<img src="https://graph.microsoft.com/v1.0/chats/chat-1/messages/msg-1/hostedContents/${b64}/$value">`,
      },
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.objectId).toBe('0-na-d3-abc123def456')
    expect(refs[0]!.region).toBe('amer')
  })

  it('routes an asm.skype.com object URL through asyncgw (non-external, with object id)', () => {
    const m = msg({
      body: {
        contentType: 'html',
        content:
          '<img src="https://eu-api.asm.skype.com/v1/objects/0-eu-d3-abc123def456/views/imgo">',
      },
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.objectId).toBe('0-eu-d3-abc123def456')
    expect(refs[0]!.region).toBe('emea')
    expect(refs[0]!.isExternal).toBe(false)
  })

  it('keeps a raw asyncgw URL on the external (asyncgw-URL) path', () => {
    const m = msg({
      body: {
        contentType: 'html',
        content:
          '<img src="https://eu-prod.asyncgw.teams.microsoft.com/v1/oid/objects/0-eu-d3-abc123def456/views/imgo">',
      },
    })
    const refs = extractInlineImages(m)
    expect(refs.length).toBe(1)
    expect(refs[0]!.isExternal).toBe(true)
    expect(refs[0]!.objectId).toBe('0-eu-d3-abc123def456')
    expect(refs[0]!.region).toBe('emea')
  })
})
