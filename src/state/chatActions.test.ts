import { accountRef } from '../account'
import { accountStore } from './accountStore'
import { createGraphClient, currentAccountContext } from '../graph/client'
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
import { createAppStore, resetAccountScopedState } from './store'
import {
  deleteChatById,
  deleteChatMessageById,
  editChatMessageContent,
  sendMessage,
  toggleReaction,
} from './chatActions'

const testClient = () => createGraphClient(currentAccountContext())

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600
const me: IdentityUser = { id: 'me-1', displayName: 'Me' }

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function setup(transport: (url: string, init: RequestInit) => Promise<Response>) {
  setAudiencePreference('graph', { fallback: false })
  // tid is what hideChat reads off the token for the hideForUser body.
  setAuthRunner(async () => ({
    stdout: makeJwt({ exp: FAR_FUTURE, tid: 'tenant-1' }),
    stderr: '',
    exitCode: 0,
  }))
  setClientTransport(transport)
  const store = createAppStore(accountRef('test'))
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
    await toggleReaction(testClient(), accountStore(store), 'c1', 'm1', 'like', me)
    expect(path).toContain('/messages/m1/setReaction')
    expect(convMsgs(store)[0]!.reactions?.[0]!.reactionType).toBe('like')
  })

  it('sends the unicode glyph (not the short name) in the Graph payload', async () => {
    // Graph rejects short names with `400 Unicode 'heart' ... not supported`;
    // the payload must carry the emoji glyph. The internal store still tracks
    // the short name.
    let body: unknown
    const store = setup(async (_url, init) => {
      body = init.body ? JSON.parse(String(init.body)) : undefined
      return ok()
    })
    await toggleReaction(testClient(), accountStore(store), 'c1', 'm1', 'heart', me)
    expect(body).toEqual({ reactionType: '❤️' })
    expect(convMsgs(store)[0]!.reactions?.[0]!.reactionType).toBe('heart')
  })

  it('removes the reaction when the same type is already set (per-type toggle)', async () => {
    let path = ''
    const store = setup(async (url) => {
      path = url
      return ok()
    })
    store.set({
      messagesByConvo: {
        'chat:c1': [
          { ...convMsgs(store)[0]!, reactions: [{ reactionType: 'like', user: { user: me } }] },
        ],
      },
    })
    await toggleReaction(testClient(), accountStore(store), 'c1', 'm1', 'like', me)
    expect(path).toContain('/messages/m1/unsetReaction')
    expect(convMsgs(store)[0]!.reactions).toEqual([])
  })

  it('adds a new type without removing the prior type (additive multi-reaction)', async () => {
    const paths: string[] = []
    const store = setup(async (url) => {
      paths.push(url)
      return ok()
    })
    // Seed with one existing reaction.
    store.set({
      messagesByConvo: {
        'chat:c1': [
          { ...convMsgs(store)[0]!, reactions: [{ reactionType: 'like', user: { user: me } }] },
        ],
      },
    })
    await toggleReaction(testClient(), accountStore(store), 'c1', 'm1', 'heart', me)
    // Should have called setReaction (not unset).
    expect(paths[0]).toContain('/messages/m1/setReaction')
    // Both reactions must be present.
    const types = convMsgs(store)[0]!.reactions!.map((r) => r.reactionType)
    expect(types).toContain('like')
    expect(types).toContain('heart')
  })

  it('removes only the targeted type, keeping other types intact', async () => {
    const store = setup(ok)
    // Seed with two reactions.
    store.set({
      messagesByConvo: {
        'chat:c1': [
          {
            ...convMsgs(store)[0]!,
            reactions: [
              { reactionType: 'like', user: { user: me } },
              { reactionType: 'heart', user: { user: me } },
            ],
          },
        ],
      },
    })
    await toggleReaction(testClient(), accountStore(store), 'c1', 'm1', 'like', me)
    const reactions = convMsgs(store)[0]!.reactions!
    expect(reactions.map((r) => r.reactionType)).toEqual(['heart'])
  })

  it('rolls back the optimistic reaction on failure', async () => {
    const store = setup(fail)
    await expect(
      toggleReaction(testClient(), accountStore(store), 'c1', 'm1', 'like', me),
    ).rejects.toThrow()
    expect(convMsgs(store)[0]!.reactions ?? []).toEqual([])
  })
})

describe('editChatMessageContent', () => {
  it('updates the body on success', async () => {
    const store = setup(ok)
    await editChatMessageContent(testClient(), accountStore(store), 'c1', 'm1', 'edited')
    expect(convMsgs(store)[0]!.body.content).toBe('edited')
  })

  it('rolls back to the original body on failure', async () => {
    const store = setup(fail)
    await expect(
      editChatMessageContent(testClient(), accountStore(store), 'c1', 'm1', 'edited'),
    ).rejects.toThrow()
    expect(convMsgs(store)[0]!.body.content).toBe('hello')
  })
})

describe('deleteChatMessageById', () => {
  it('tombstones the message on success', async () => {
    const store = setup(ok)
    await deleteChatMessageById(testClient(), accountStore(store), 'c1', 'm1')
    expect(convMsgs(store)[0]!.deletedDateTime).toBeTruthy()
  })

  it('restores the message on failure', async () => {
    const store = setup(fail)
    await expect(
      deleteChatMessageById(testClient(), accountStore(store), 'c1', 'm1'),
    ).rejects.toThrow()
    expect(convMsgs(store)[0]!.deletedDateTime).toBeUndefined()
  })
})

describe('deleteChatById', () => {
  it('hides the chat and drops it from the list', async () => {
    const seen: string[] = []
    const store = setup(async (url) => {
      seen.push(url)
      return new Response(null, { status: 204 })
    })
    store.set({
      me: { id: 'me-1', displayName: 'Me', userPrincipalName: 'me@x', mail: null },
      chats: [
        { id: 'c1', chatType: 'oneOnOne', createdDateTime: '2026-01-01T00:00:00Z' },
        { id: 'c2', chatType: 'oneOnOne', createdDateTime: '2026-01-01T00:00:00Z' },
      ],
      focus: { kind: 'chat', chatId: 'c1' },
    })
    await deleteChatById(testClient(), accountStore(store), 'c1')
    expect(seen[0]).toContain('/chats/c1/hideForUser')
    expect(store.get().chats.map((c) => c.id)).toEqual(['c2'])
    // focus is global UI state: moving it off the deleted chat is the caller's job
    expect(store.get().focus).toEqual({ kind: 'chat', chatId: 'c1' })
  })

  it('puts the chat back when the hide call fails', async () => {
    const store = setup(async () => new Response('nope', { status: 500 }))
    store.set({
      me: { id: 'me-1', displayName: 'Me', userPrincipalName: 'me@x', mail: null },
      chats: [{ id: 'c1', chatType: 'oneOnOne', createdDateTime: '2026-01-01T00:00:00Z' }],
    })
    await expect(deleteChatById(testClient(), accountStore(store), 'c1')).rejects.toThrow()
    expect(store.get().chats.map((c) => c.id)).toEqual(['c1'])
  })
})

describe('sendMessage', () => {
  const chat = { kind: 'chat', chatId: 'c1' } as const
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

  it('shows the message at once, then swaps in the server copy', async () => {
    let pendingCheck: ChatMessage[] = []
    const store = setup(async () => {
      pendingCheck = convMsgs(store)
      return json({
        id: 'server-1',
        createdDateTime: 'x',
        body: { contentType: 'text', content: 'hi' },
      })
    })
    store.set({ draftsByConvo: { 'chat:c1': 'hi' } })
    expect(await sendMessage(testClient(), accountStore(store), chat, 'hi')).toEqual({ ok: true })
    expect(pendingCheck.at(-1)?._sending).toBe(true)
    expect(convMsgs(store).map((m) => m.id)).toEqual(['m1', 'server-1'])
    expect(store.get().draftsByConvo['chat:c1']).toBeUndefined()
  })

  it('marks a failed send and puts the text back in the draft', async () => {
    const store = setup(fail)
    const result = await sendMessage(testClient(), accountStore(store), chat, 'hi')
    expect(result.ok).toBe(false)
    const row = convMsgs(store).at(-1)!
    expect(row._sending).toBe(false)
    expect(row._sendError).toBeTruthy()
    expect(store.get().draftsByConvo['chat:c1']).toBe('hi')
  })

  it('a failed send goes above a draft typed in that chat since, not over it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const store = setup(async (...args: unknown[]) => {
      await gate
      return (fail as (...a: unknown[]) => Promise<Response>)(...args)
    })
    const pending = sendMessage(testClient(), accountStore(store), chat, 'hi')
    store.set((s) => ({ draftsByConvo: { ...s.draftsByConvo, 'chat:c1': 'typed since' } }))
    release()
    await pending
    expect(store.get().draftsByConvo['chat:c1']).toBe('hi\ntyped since')
  })

  it('writes nothing after the call once the account changed', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const store = setup(async () => {
      await gate
      return json({
        id: 'server-1',
        createdDateTime: 'x',
        body: { contentType: 'text', content: 'hi' },
      })
    })
    const pending = sendMessage(testClient(), accountStore(store), chat, 'hi')
    resetAccountScopedState(store, accountRef('other'))
    release()
    await pending
    expect(convMsgs(store)).toEqual([])
  })
})
