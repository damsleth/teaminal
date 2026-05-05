import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { __resetForTests, __setTransportForTests } from '../../graph/client'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../../auth/owaPiggy'
import type { ChatMessage } from '../../types'
import { createAppStore, type ConvKey } from '../store'
import { loadOlderMessages } from './loadOlder'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function primeAuth(): void {
  setAuthRunner(async () => ({
    stdout: makeJwt({ exp: FAR_FUTURE, oid: 'me-oid' }),
    stderr: '',
    exitCode: 0,
  }))
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function msg(id: string, ts: string, extra?: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    createdDateTime: ts,
    body: { contentType: 'text', content: id },
    ...extra,
  }
}

beforeEach(() => {
  primeAuth()
})

afterEach(() => {
  __resetForTests()
  resetAuth()
})

describe('loadOlderMessages', () => {
  test('returns conv=null with fullyLoaded=true when nothing is focused', async () => {
    const store = createAppStore()
    const result = await loadOlderMessages({ store, reportError: () => {} })
    expect(result).toEqual({ conv: null, added: 0, fullyLoaded: true })
  })

  test('returns fullyLoaded=true without fetching when cache is fullyLoaded', async () => {
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse({ value: [] })
    })
    const store = createAppStore()
    const conv: ConvKey = 'chat:c1'
    store.set({
      focus: { kind: 'chat', chatId: 'c1' },
      messageCacheByConvo: {
        [conv]: { messages: [msg('m1', 'x')], loadingOlder: false, fullyLoaded: true },
      },
    })
    const result = await loadOlderMessages({ store, reportError: () => {} })
    expect(result.fullyLoaded).toBe(true)
    expect(calls).toBe(0)
  })

  test('refuses to start a second fetch while an earlier one is still in flight', async () => {
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse({ value: [] })
    })
    const store = createAppStore()
    const conv: ConvKey = 'chat:c1'
    store.set({
      focus: { kind: 'chat', chatId: 'c1' },
      messageCacheByConvo: {
        [conv]: { messages: [msg('m1', 'x')], loadingOlder: true, fullyLoaded: false },
      },
    })
    const result = await loadOlderMessages({ store, reportError: () => {} })
    expect(result.added).toBe(0)
    expect(calls).toBe(0)
  })

  test('marks channel cache fullyLoaded when there is no nextLink', async () => {
    let calls = 0
    __setTransportForTests(async () => {
      calls++
      return jsonResponse({ value: [] })
    })
    const store = createAppStore()
    const conv: ConvKey = 'channel:t1:ch1'
    store.set({
      focus: { kind: 'channel', teamId: 't1', channelId: 'ch1' },
      messageCacheByConvo: {
        [conv]: { messages: [msg('m1', 'x')], loadingOlder: false, fullyLoaded: false },
      },
    })
    const result = await loadOlderMessages({ store, reportError: () => {} })
    expect(result.fullyLoaded).toBe(true)
    expect(calls).toBe(0)
    expect(store.get().messageCacheByConvo[conv]?.fullyLoaded).toBe(true)
  })

  test('fetches an older page for a chat using beforeCreatedDateTime when no nextLink', async () => {
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({
        value: [msg('older-2', '2026-01-01T00:00:01Z'), msg('older-1', '2026-01-01T00:00:00Z')],
      })
    })
    const store = createAppStore()
    const conv: ConvKey = 'chat:c1'
    store.set({
      focus: { kind: 'chat', chatId: 'c1' },
      messageCacheByConvo: {
        [conv]: {
          messages: [msg('m1', '2026-01-01T01:00:00Z')],
          loadingOlder: false,
          fullyLoaded: false,
        },
      },
    })
    const result = await loadOlderMessages({ store, reportError: () => {} })
    expect(seenUrl).toContain('/v1.0/chats/c1/messages')
    expect(seenUrl.replace(/\+/g, ' ')).toContain('createdDateTime lt')
    expect(result.added).toBe(2)
    const merged = store.get().messageCacheByConvo[conv]?.messages.map((m) => m.id) ?? []
    expect(merged).toEqual(['older-1', 'older-2', 'm1'])
  })

  test('records the error and clears loadingOlder on a fetch failure', async () => {
    __setTransportForTests(async () => new Response('boom', { status: 500 }))
    const store = createAppStore()
    const conv: ConvKey = 'chat:c1'
    store.set({
      focus: { kind: 'chat', chatId: 'c1' },
      messageCacheByConvo: {
        [conv]: {
          messages: [msg('m1', '2026-01-01T00:00:00Z')],
          loadingOlder: false,
          fullyLoaded: false,
        },
      },
    })
    const errors: Error[] = []
    const result = await loadOlderMessages({
      store,
      reportError: (e) => errors.push(e),
    })
    expect(result.error).toBeInstanceOf(Error)
    expect(errors).toHaveLength(1)
    const cache = store.get().messageCacheByConvo[conv]
    expect(cache?.loadingOlder).toBe(false)
    expect(cache?.error).toBeDefined()
  })
})
