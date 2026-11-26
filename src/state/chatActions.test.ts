import { accountRef } from '../account'
import { accountStore, openAccount, setForeground } from './accountStore'
import { groupChannelThreads, replyCountForRoot } from './channelThreads'
import { createGraphClient, type AccountContext } from '../graph/client'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests as resetClient,
  __setTransportForTests as setClientTransport,
} from '../graph/client'
import { __resetChatMessageFallbackForTests } from '../graph/chats'
import type { ChatMessage, IdentityUser } from '../types'
import {
  accountSlice,
  createAppStore,
  emptyMessageCache,
  focusKey,
  resetAccountScopedState,
} from './store'
import {
  __resetForTests as resetChatsvc,
  __setTransportForTests as setChatsvcTransport,
} from '../graph/teamsChatsvc'
import {
  __resetForTests as resetFederation,
  __setTransportForTests as setFederationTransport,
} from '../graph/teamsFederation'
import { __setRegionForTests } from '../graph/teamsRegion'
import { mergeActivePagePatch } from './poller/pagePatch'
import {
  deleteChatById,
  deleteChatMessageById,
  editChatMessageContent,
  sendMessage,
  toggleReaction,
} from './chatActions'

const testClient = (over: Partial<AccountContext> = {}) =>
  createGraphClient({ account: accountRef(undefined), audience: 'graph', fallback: false, ...over })

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600
const me: IdentityUser = { id: 'me-1', displayName: 'Me' }

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function setup(transport: (url: string, init: RequestInit) => Promise<Response>) {
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

// The poller merges from messageCacheByConvo; these drive an action and then
// the real head-poll patch, the way a live session interleaves them.
describe('actions and the next poll', () => {
  const chat = { kind: 'chat', chatId: 'c1' } as const
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  const poll = (store: ReturnType<typeof createAppStore>, messages: ChatMessage[]) =>
    store.set(
      mergeActivePagePatch(store.get(), 'chat:c1', { messages }, { kind: 'chat', chatId: 'c1' }),
    )
  const withCache = (store: ReturnType<typeof createAppStore>) => {
    store.set(() => ({ messageCacheByConvo: { 'chat:c1': emptyMessageCache(convMsgs(store)) } }))
    return store
  }
  const m1 = convMsgsSeed()

  it('a confirmed send survives a poll that does not carry it yet', async () => {
    const store = withCache(
      setup(async () =>
        json({
          id: 'server-1',
          createdDateTime: '2026-05-29T10:01:00Z',
          body: { contentType: 'text', content: 'hi' },
        }),
      ),
    )
    await sendMessage(testClient(), accountStore(store), chat, 'hi')
    poll(store, [m1])
    expect(convMsgs(store).map((m) => m.id)).toEqual(['m1', 'server-1'])
  })

  it('an echo that lands before the POST resolves leaves one row', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const server = {
      id: 'server-1',
      createdDateTime: '2026-05-29T10:01:00Z',
      body: { contentType: 'text' as const, content: 'hi' },
    }
    const store = withCache(
      setup(async () => {
        await gate
        return json(server)
      }),
    )
    const pending = sendMessage(testClient(), accountStore(store), chat, 'hi')
    const cmid = convMsgs(store).at(-1)!.clientMessageId
    expect(cmid).toBeTruthy()
    // chatsvc echoes carry the client message id.
    poll(store, [m1, { ...server, clientMessageId: cmid }])
    expect(convMsgs(store).map((m) => m.id)).toEqual(['m1', 'server-1'])
    release()
    expect(await pending).toEqual({ ok: true })
    expect(convMsgs(store).map((m) => m.id)).toEqual(['m1', 'server-1'])
  })

  it('a Graph echo (same id, no client id) before the POST resolves leaves one row', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const server = {
      id: 'server-1',
      createdDateTime: '2026-05-29T10:01:00Z',
      body: { contentType: 'text' as const, content: 'hi' },
    }
    const store = withCache(
      setup(async () => {
        await gate
        return json(server)
      }),
    )
    const pending = sendMessage(testClient(), accountStore(store), chat, 'hi')
    poll(store, [m1, server])
    release()
    await pending
    expect(convMsgs(store).map((m) => m.id)).toEqual(['m1', 'server-1'])
    poll(store, [m1, server])
    expect(convMsgs(store).map((m) => m.id)).toEqual(['m1', 'server-1'])
  })

  it('a POST that fails after its echo landed still counts as sent', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const store = withCache(
      setup(async () => {
        await gate
        return fail()
      }),
    )
    store.set({ draftsByConvo: { 'chat:c1': 'hi' } })
    const pending = sendMessage(testClient(), accountStore(store), chat, 'hi')
    const cmid = convMsgs(store).at(-1)!.clientMessageId
    poll(store, [
      m1,
      {
        id: 'server-1',
        clientMessageId: cmid,
        createdDateTime: '2026-05-29T10:01:00Z',
        body: { contentType: 'text', content: 'hi' },
      },
    ])
    release()
    expect(await pending).toEqual({ ok: true })
    expect(convMsgs(store).map((m) => m.id)).toEqual(['m1', 'server-1'])
    expect(store.get().messageCacheByConvo['chat:c1']!.messages).toBe(convMsgs(store))
    expect(convMsgs(store).some((m) => m._sendError || m._sending)).toBe(false)
    expect(store.get().draftsByConvo['chat:c1']).toBeUndefined()
  })

  it('a reaction survives a poll that does not carry it yet', async () => {
    const store = withCache(setup(ok))
    await toggleReaction(testClient(), accountStore(store), 'c1', 'm1', 'like', me)
    poll(store, [m1])
    expect(convMsgs(store)[0]!.reactions?.map((r) => r.reactionType)).toEqual(['like'])
  })

  it('a failed edit restores only that message, keeping ones that arrived meanwhile', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const store = withCache(
      setup(async () => {
        await gate
        return fail()
      }),
    )
    const pending = editChatMessageContent(testClient(), accountStore(store), 'c1', 'm1', 'edited')
    const m2: ChatMessage = { ...m1, id: 'm2', createdDateTime: '2026-05-29T10:02:00Z' }
    poll(store, [{ ...m1, body: { contentType: 'text', content: 'edited' } }, m2])
    release()
    await expect(pending).rejects.toThrow()
    // The poll already replaced the optimistic copy: it wins, m2 stays.
    expect(convMsgs(store).map((m) => [m.id, m.body.content])).toEqual([
      ['m1', 'edited'],
      ['m2', 'hello'],
    ])
  })

  it('a failed edit with no poll in between puts the original back', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const store = withCache(
      setup(async () => {
        await gate
        return fail()
      }),
    )
    const pending = editChatMessageContent(testClient(), accountStore(store), 'c1', 'm1', 'edited')
    store.set(() => ({
      messagesByConvo: {
        'chat:c1': [
          ...convMsgs(store),
          { ...m1, id: 'm2', createdDateTime: '2026-05-29T10:02:00Z' },
        ],
      },
    }))
    release()
    await expect(pending).rejects.toThrow()
    expect(convMsgs(store).map((m) => [m.id, m.body.content])).toEqual([
      ['m1', 'hello'],
      ['m2', 'hello'],
    ])
  })
})

function convMsgsSeed(): ChatMessage {
  return {
    id: 'm1',
    createdDateTime: '2026-05-29T10:00:00Z',
    body: { contentType: 'text', content: 'hello' },
    from: { user: me },
  }
}

describe('thread reply send', () => {
  afterEach(() => {
    resetChatsvc()
    resetFederation()
  })

  // chatsvc auth: Skype token via the federation transport, fixed region.
  const chatsvcAuth = (...profiles: string[]) => {
    setFederationTransport(
      async () =>
        new Response(JSON.stringify({ tokens: { skypeToken: 'skype', expiresIn: 3600 } }), {
          headers: { 'content-type': 'application/json' },
        }),
    )
    for (const p of profiles) __setRegionForTests(p, 'emea')
  }
  const root: ChatMessage = {
    id: 'root1',
    rootMessageId: 'root1',
    createdDateTime: '2026-05-29T09:00:00Z',
    body: { contentType: 'text', content: 'root' },
  }
  const focus = { kind: 'thread', teamId: 't1', channelId: 'ch1', rootId: 'root1' } as const
  const channelFocus = { kind: 'channel', teamId: 't1', channelId: 'ch1' } as const
  const threadConv = 'thread:t1:ch1:root1'
  const channelConv = 'channel:t1:ch1'
  // Both conversations loaded with caches, so the send goes through convPatch.
  const loadedThread = () => ({
    messagesByConvo: { [channelConv]: [root], [threadConv]: [root] },
    messageCacheByConvo: {
      [channelConv]: emptyMessageCache([root]),
      [threadConv]: emptyMessageCache([root]),
    },
  })
  const created = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })

  it('a reply whose POST returns no id merges with the poll copy carrying its client id', async () => {
    const store = setup(ok)
    chatsvcAuth('test')
    // 201 with neither a body id nor a Location header: the row's id is the client id.
    setChatsvcTransport(async () => created({ OriginalArrivalTime: '2026-05-29T09:05:00Z' }))
    store.set({ me: me as never, ...loadedThread() })
    expect(await sendMessage(testClient(), accountStore(store), focus, 'hi')).toEqual({ ok: true })
    const cmid = store.get().messagesByConvo[channelConv]!.at(-1)!.clientMessageId!
    expect(store.get().messagesByConvo[channelConv]!.map((m) => m.id)).toEqual(['root1', cmid])

    const serverReply: ChatMessage = {
      id: 'reply-1',
      clientMessageId: cmid,
      replyToId: 'root1',
      rootMessageId: 'root1',
      createdDateTime: '2026-05-29T09:05:00Z',
      body: { contentType: 'text', content: 'hi' },
    }
    store.set(
      mergeActivePagePatch(
        store.get(),
        channelConv,
        { messages: [root, serverReply], nextLink: 'older' },
        channelFocus,
      ),
    )
    const stream = store.get().messagesByConvo[channelConv]!
    expect(store.get().messageCacheByConvo[channelConv]!.messages).toBe(stream)
    expect(stream.map((m) => [m.id, m.replyToId, m.rootMessageId])).toEqual([
      ['root1', undefined, 'root1'],
      ['reply-1', 'root1', 'root1'],
    ])
    expect(replyCountForRoot(groupChannelThreads(stream), 'root1')).toBe(1)

    // The thread door's copy settles the thread view the same way.
    store.set(
      mergeActivePagePatch(store.get(), threadConv, { messages: [root, serverReply] }, focus),
    )
    const thread = store.get().messagesByConvo[threadConv]!
    expect(store.get().messageCacheByConvo[threadConv]!.messages).toBe(thread)
    expect(thread.map((m) => m.id)).toEqual(['root1', 'reply-1'])
  })

  it('a reply sent from A lands in A after B comes to the foreground mid-send', async () => {
    const alice = accountRef('alice')
    const bob = accountRef('bob')
    const store = setup(ok)
    resetAccountScopedState(store, alice)
    chatsvcAuth('alice')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    setChatsvcTransport(async () => {
      await gate
      return created({ id: 'reply-1', OriginalArrivalTime: '2026-05-29T09:05:00Z' })
    })
    const a = accountStore(store)
    a.set({ me: me as never, ...loadedThread(), draftsByConvo: { [threadConv]: 'hi' } })
    const b = openAccount(store, bob, { foreground: false })
    b.set({ ...loadedThread(), draftsByConvo: { [threadConv]: 'bob draft' } })
    const bobBefore = accountSlice(store.get(), bob.id)!

    // A's client and handle are bound before the await, as the composer does.
    const pending = sendMessage(testClient({ account: alice }), a, focus, 'hi')
    setForeground(store, bob.id)
    release()
    expect(await pending).toEqual({ ok: true })

    const aSlice = accountSlice(store.get(), alice.id)!
    expect(store.get().account?.id).toBe(bob.id)
    expect(store.get().backgroundAccounts[alice.id]).toBe(aSlice as never)
    for (const conv of [threadConv, channelConv]) {
      expect(aSlice.messagesByConvo[conv]!.map((m) => [m.id, m.replyToId])).toEqual([
        ['root1', undefined],
        ['reply-1', 'root1'],
      ])
      expect(aSlice.messageCacheByConvo[conv]!.messages).toBe(aSlice.messagesByConvo[conv]!)
    }
    expect(aSlice.draftsByConvo[threadConv]).toBeUndefined()

    const bobNow = accountSlice(store.get(), bob.id)!
    expect(bobNow.messagesByConvo).toBe(bobBefore.messagesByConvo)
    expect(bobNow.messageCacheByConvo).toBe(bobBefore.messageCacheByConvo)
    expect(bobNow.draftsByConvo).toBe(bobBefore.draftsByConvo)
    expect(bobNow.draftsByConvo[threadConv]).toBe('bob draft')
  })

  it("sends with the optimistic row's client id and lands in the loaded channel stream", async () => {
    const store = setup(ok)
    chatsvcAuth('test')
    let wireCmid: unknown
    let wireName: unknown
    let wireUrl = ''
    let rowCmid: string | undefined
    setChatsvcTransport(async (url, init) => {
      wireUrl = url
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      wireCmid = body.clientmessageid
      wireName = body.imdisplayname
      rowCmid = store.get().messagesByConvo['thread:t1:ch1:root1']?.at(-1)?.clientMessageId
      return new Response(JSON.stringify({ id: 'reply-1', OriginalArrivalTime: Date.now() }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    })
    store.set({ me: me as never, messagesByConvo: { [channelConv]: [root] } })
    expect(focusKey(focus)).toBe(threadConv)
    expect(await sendMessage(testClient(), accountStore(store), focus, 'hi')).toEqual({ ok: true })
    expect(wireCmid).toBeTruthy()
    expect(wireCmid).toBe(rowCmid)
    const stream = store.get().messagesByConvo[channelConv] ?? []
    expect(stream.map((m) => [m.id, m.replyToId])).toEqual([
      ['root1', undefined],
      ['reply-1', 'root1'],
    ])
    // Live 2026-11-25: posted to the channel itself, the server made it a new
    // root, and with no author on the row it vanished from the view.
    expect(wireUrl).toContain(';messageid=root1/messages')
    expect(wireName).toBe('Me')
    expect(stream.at(-1)?.from?.user?.id).toBe('me-1')
  })
})

it('a failed reaction rolls back even after a poll rebuilt the message', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const store = setup(async () => {
    await gate
    return fail()
  })
  store.set(() => ({ messageCacheByConvo: { 'chat:c1': emptyMessageCache(convMsgs(store)) } }))
  const pending = toggleReaction(testClient(), accountStore(store), 'c1', 'm1', 'like', me)
  const m1 = convMsgs(store)[0]!
  store.set(
    mergeActivePagePatch(
      store.get(),
      'chat:c1',
      {
        // A new message makes the poll rebuild the list (and the reacted row).
        messages: [
          { ...m1, reactions: undefined, _reactionsPendingAt: undefined },
          { ...m1, id: 'm2', createdDateTime: '2026-05-29T10:05:00Z', reactions: undefined },
        ],
      },
      { kind: 'chat', chatId: 'c1' },
    ),
  )
  expect(convMsgs(store)[0]!.reactions?.length).toBe(1)
  release()
  await expect(pending).rejects.toThrow()
  expect(convMsgs(store)[0]!.reactions ?? []).toEqual([])
})
