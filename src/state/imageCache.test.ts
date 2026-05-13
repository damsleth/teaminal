import { afterEach, describe, expect, it, mock } from 'bun:test'
import { isImageAttachment, attachmentGraphPath } from '../types'
import type { MessageAttachment } from '../types'
import { fetchAndCacheImage, imageCacheKey as cacheKey } from './imageCache'

describe('imageCacheKey', () => {
  it('combines messageId and attachmentId with ::', () => {
    expect(cacheKey('msg-1', 'att-2')).toBe('msg-1::att-2')
  })

  it('never contains the attachment URL (no credential leak)', () => {
    const key = cacheKey('msg-abc', 'att-xyz')
    expect(key).not.toContain('https://')
    expect(key).not.toContain('token')
  })
})

describe('isImageAttachment', () => {
  const att = (contentType: string, name?: string): MessageAttachment => ({
    id: 'x',
    contentType,
    name: name ?? null,
  })

  it('matches explicit image/* MIME types', () => {
    expect(isImageAttachment(att('image/png'))).toBe(true)
    expect(isImageAttachment(att('image/jpeg'))).toBe(true)
    expect(isImageAttachment(att('image/gif'))).toBe(true)
    expect(isImageAttachment(att('image/webp'))).toBe(true)
  })

  it('matches by filename extension for Teams hosted content', () => {
    expect(isImageAttachment(att('application/vnd.microsoft.teams.file.download.info', 'photo.png'))).toBe(true)
    expect(isImageAttachment(att('reference', 'screenshot.jpeg'))).toBe(true)
    expect(isImageAttachment(att('reference', 'diagram.svg'))).toBe(true)
  })

  it('does not match non-image MIME types without image extension', () => {
    expect(isImageAttachment(att('application/pdf', 'report.pdf'))).toBe(false)
    expect(isImageAttachment(att('text/plain', 'notes.txt'))).toBe(false)
    expect(isImageAttachment(att('application/vnd.ms-excel', 'data.xlsx'))).toBe(false)
  })
})

describe('attachmentGraphPath', () => {
  const chatId = 'chat-abc'
  const msgId = 'msg-def'

  it('strips the Graph v1 base from a contentUrl', () => {
    const att: MessageAttachment = {
      id: 'att-1',
      contentType: 'image/png',
      contentUrl: 'https://graph.microsoft.com/v1.0/chats/chat-abc/messages/msg-def/hostedContents/att-1/$value',
    }
    const path = attachmentGraphPath(att, chatId, msgId)
    expect(path).toBe('/chats/chat-abc/messages/msg-def/hostedContents/att-1/$value')
    expect(path).not.toContain('https://graph.microsoft.com')
  })

  it('falls back to hostedContents path when contentUrl is null', () => {
    const att: MessageAttachment = {
      id: 'att-99',
      contentType: 'reference',
      contentUrl: null,
      name: 'image.png',
    }
    const path = attachmentGraphPath(att, chatId, msgId)
    expect(path).toContain('/hostedContents/')
    expect(path).toContain('att-99')
    expect(path).toEndWith('/$value')
  })

  it('URL-encodes special chars in IDs', () => {
    const att: MessageAttachment = {
      id: 'att with spaces',
      contentType: 'image/jpeg',
      contentUrl: null,
    }
    const path = attachmentGraphPath(att, 'chat/id', 'msg/id')
    expect(path).not.toContain(' ')
    expect(path).toContain('att%20with%20spaces')
  })
})

describe('fetchAndCacheImage isExternal branch', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('does not send Authorization when isExternal is true', async () => {
    let capturedHeaders: Headers | null = null
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fakeFetch = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers ?? {})
      return new Response(bytes, { status: 200 })
    })
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    const key = `external-test-${Date.now()}`
    const buf = await fetchAndCacheImage(
      'https://media.giphy.com/test.gif',
      key,
      { contentType: 'image/gif', name: 'test.gif' },
      { isExternal: true, profile: '__external_test__' },
    )

    expect(buf).not.toBeNull()
    expect(capturedHeaders).not.toBeNull()
    expect(capturedHeaders!.get('authorization')).toBeNull()
    expect(capturedHeaders!.get('Authorization')).toBeNull()
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })
})
