import { afterEach, describe, expect, it } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests as resetClient,
  __setTransportForTests as setClientTransport,
  setAudiencePreference,
} from '../graph/client'
import { __resetChatMessageFallbackForTests } from '../graph/chats'
import type { ChatMessage, IdentityUser } from '../types'
import { createAppStore } from './store'
import { deleteChatMessageById, editChatMessageContent, toggleReaction } from './chatActions'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600
const me: IdentityUser = { id: 'me-1', displayName: 'Me' }

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function setup(transport: (url: string, init: RequestInit) => Promise<Response>) {
  setAudiencePreference('graph', { fallback: false })
  setAuthRunner(async () => ({ stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }))
  setClientTransport(transport)
  const store = createAppStore()
  const msg: ChatMessage = {
    id: 'm1',
    createdDateTime: '2026-05-29T10:00:00Z',
    body: { contentType: 'text', content: 'hello' },
    from: { user: me },
  }
  store.set({ messagesByConvo: { 'chat:c1': [msg] } })
  return store
}

const ok = async () => new Response(null, { status: 204 })
const fail = async () => new Response('nope', { status: 500 })
const convMsgs = (store: ReturnType<typeof createAppStore>) =>
  store.get().messagesByConvo['chat:c1'] ?? []

afterEach(() => {
  resetClient()
  resetAuth()
  __resetChatMessageFallbackForTests()
})

describe('toggleReaction', () => {
  it('adds the reaction and keeps it on success', async () => {
    let path = ''
    const store = setup(async (url) => {
      path = url
      return ok()
    })
    await toggleReaction(store, 'c1', 'm1', 'like', me)
    expect(path).toContain('/messages/m1/setReaction')
    expect(convMsgs(store)[0]!.reactions?.[0]!.reactionType).toBe('like')
  })

  it('removes the reaction when the same type is already set (toggle)', async () => {
    let path = ''
    const store = setup(async (url) => {
      path = url
      return ok()
    })
    store.set({
      messagesByConvo: {
        'chat:c1': [{ ...convMsgs(store)[0]!, reactions: [{ reactionType: 'like', user: { user: me } }] }],
      },
    })
    await toggleReaction(store, 'c1', 'm1', 'like', me)
    expect(path).toContain('/messages/m1/unsetReaction')
    expect(convMsgs(store)[0]!.reactions).toEqual([])
  })

  it('rolls back the optimistic reaction on failure', async () => {
    const store = setup(fail)
    await expect(toggleReaction(store, 'c1', 'm1', 'like', me)).rejects.toThrow()
    expect(convMsgs(store)[0]!.reactions ?? []).toEqual([])
  })
})

describe('editChatMessageContent', () => {
  it('updates the body on success', async () => {
    const store = setup(ok)
    await editChatMessageContent(store, 'c1', 'm1', 'edited')
    expect(convMsgs(store)[0]!.body.content).toBe('edited')
  })

  it('rolls back to the original body on failure', async () => {
    const store = setup(fail)
    await expect(editChatMessageContent(store, 'c1', 'm1', 'edited')).rejects.toThrow()
    expect(convMsgs(store)[0]!.body.content).toBe('hello')
  })
})

describe('deleteChatMessageById', () => {
  it('tombstones the message on success', async () => {
    const store = setup(ok)
    await deleteChatMessageById(store, 'c1', 'm1')
    expect(convMsgs(store)[0]!.deletedDateTime).toBeTruthy()
  })

  it('restores the message on failure', async () => {
    const store = setup(fail)
    await expect(deleteChatMessageById(store, 'c1', 'm1')).rejects.toThrow()
    expect(convMsgs(store)[0]!.deletedDateTime).toBeUndefined()
  })
})
