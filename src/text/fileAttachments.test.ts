import { describe, expect, test } from 'bun:test'
import type { ChatMessage, MessageAttachment } from '../types'
import { extractFileAttachments, formatBytes } from './fileAttachments'

function msg(attachments: MessageAttachment[]): ChatMessage {
  return {
    id: 'm1',
    createdDateTime: '2026-05-20T10:00:00Z',
    messageType: 'message',
    body: { contentType: 'text', content: '' },
    attachments,
  }
}

function att(partial: Partial<MessageAttachment> & { id: string }): MessageAttachment {
  return {
    id: partial.id,
    contentType: partial.contentType ?? '',
    name: partial.name ?? null,
    contentUrl: partial.contentUrl ?? null,
    content: partial.content ?? null,
    thumbnailUrl: partial.thumbnailUrl ?? null,
  }
}

describe('extractFileAttachments', () => {
  test('returns SharePoint file references', () => {
    const out = extractFileAttachments(
      msg([
        att({
          id: '1',
          contentType: 'reference',
          name: 'Report.pdf',
          contentUrl: 'https://contoso.sharepoint.com/files/report.pdf',
        }),
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('Report.pdf')
    expect(out[0]!.contentType).toBe('reference')
    expect(out[0]!.sourceUrl).toContain('sharepoint.com')
  })

  test('skips images', () => {
    const out = extractFileAttachments(
      msg([
        att({
          id: '1',
          contentType: 'image/png',
          name: 'photo.png',
          contentUrl: 'https://graph.microsoft.com/v1.0/foo',
        }),
      ]),
    )
    expect(out).toEqual([])
  })

  test('skips quoted-reply (messageReference) entries', () => {
    const out = extractFileAttachments(
      msg([
        att({
          id: '1',
          contentType: 'messageReference',
          contentUrl: 'https://example.com/x',
          content: '{"messageId":"x"}',
        }),
      ]),
    )
    expect(out).toEqual([])
  })

  test('parses size from JSON content when present', () => {
    const out = extractFileAttachments(
      msg([
        att({
          id: '1',
          contentType: 'reference',
          name: 'Report.pdf',
          contentUrl: 'https://contoso.sharepoint.com/x.pdf',
          content: JSON.stringify({ fileSize: 1234567 }),
        }),
      ]),
    )
    expect(out[0]!.sizeBytes).toBe(1234567)
  })

  test('falls back to the URL tail when no name is provided', () => {
    const out = extractFileAttachments(
      msg([
        att({
          id: '1',
          contentType: 'application/pdf',
          contentUrl: 'https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/abc/views/original',
        }),
      ]),
    )
    expect(out[0]!.name).toBe('original')
  })
})

describe('formatBytes', () => {
  test('formats byte ranges', () => {
    expect(formatBytes(undefined)).toBe('')
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
})
