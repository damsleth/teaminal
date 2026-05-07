import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests,
  __setTransportForTests,
  conversationExistsInTeams,
  federatedUserOids,
  fetchFederatedUsers,
  getMsnp24EquivalentConversationId,
  resolveFederatedEquivalentConversationId,
  TEAMS_IC3_SCOPE,
  TEAMS_SPACES_SCOPE,
} from './teamsFederation'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

function primeAuth(): string[][] {
  const calls: string[][] = []
  setAuthRunner(async (args) => {
    calls.push(args)
    return { stdout: makeJwt({ exp: FAR_FUTURE }), stderr: '', exitCode: 0 }
  })
  return calls
}

afterEach(() => {
  __resetForTests()
  resetAuth()
})

describe('fetchFederatedUsers', () => {
  test('posts orgid MRIs to Teams fetchFederated with the spaces token', async () => {
    const calls = primeAuth()
    let seenUrl = ''
    let seenBody = ''
    __setTransportForTests(async (url, init) => {
      seenUrl = url
      seenBody = String(init.body)
      return jsonResponse([{ mri: '8:orgid:other' }])
    })

    const users = await fetchFederatedUsers(['other'])

    expect(users).toEqual([{ mri: '8:orgid:other' }])
    expect(seenUrl).toBe(
      'https://teams.microsoft.com/api/mt/part/emea/beta/users/fetchFederated?edEnabled=false&includeDisabledAccounts=true',
    )
    expect(JSON.parse(seenBody)).toEqual(['8:orgid:other'])
    expect(calls[0]).toEqual(['token', '--scope', TEAMS_SPACES_SCOPE])
  })
})

describe('federatedUserOids', () => {
  test('extracts canonical orgid MRIs from nested fetchFederated responses', () => {
    expect(
      federatedUserOids([
        { mri: '8:orgid:4bc16140-a25f-46fa-af77-572d8b946c1c' },
        { nested: { userId: '8:orgid:0caa699d-79d5-4660-81d0-ce05b8954fc7' } },
      ]),
    ).toEqual(['4bc16140-a25f-46fa-af77-572d8b946c1c', '0caa699d-79d5-4660-81d0-ce05b8954fc7'])
  })
})

describe('getMsnp24EquivalentConversationId', () => {
  test('returns null on the Teams 404 shape from detached chats', async () => {
    primeAuth()
    __setTransportForTests(async () => jsonResponse({ message: 'not found' }, { status: 404 }))

    await expect(
      getMsnp24EquivalentConversationId('19:detached@unq.gbl.spaces'),
    ).resolves.toBeNull()
  })

  test('extracts a canonical conversation id from nested response bodies', async () => {
    primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ conversation: { id: '19:canonical@thread.v2' } })
    })

    await expect(getMsnp24EquivalentConversationId('19:detached@unq.gbl.spaces')).resolves.toBe(
      '19:canonical@thread.v2',
    )
    expect(seenUrl).toBe(
      'https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations/19%3Adetached%40unq.gbl.spaces?view=msnp24Equivalent',
    )
  })
})

describe('conversationExistsInTeams', () => {
  test('checks the HAR-matched consumptionhorizons endpoint with an IC3 token', async () => {
    const calls = primeAuth()
    let seenUrl = ''
    __setTransportForTests(async (url) => {
      seenUrl = url
      return jsonResponse({ id: '19:canonical@unq.gbl.spaces', consumptionhorizons: [] })
    })

    await expect(conversationExistsInTeams('19:canonical@unq.gbl.spaces')).resolves.toBe(true)

    expect(seenUrl).toBe(
      'https://teams.microsoft.com/api/chatsvc/emea/v1/threads/19%3Acanonical%40unq.gbl.spaces/consumptionhorizons',
    )
    expect(calls[0]).toEqual(['token', '--scope', TEAMS_IC3_SCOPE])
  })
})

describe('resolveFederatedEquivalentConversationId', () => {
  test('prefers the federated canonical MRI before the originally selected user id', async () => {
    primeAuth()
    const urls: string[] = []
    const self = '6555c7ee-7c68-4aa8-9f0c-05164c288c36'
    const selected = '0caa699d-79d5-4660-81d0-ce05b8954fc7'
    const canonical = '4bc16140-a25f-46fa-af77-572d8b946c1c'
    __setTransportForTests(async (url) => {
      urls.push(url)
      if (url.includes('fetchFederated')) {
        return jsonResponse([{ mri: `8:orgid:${canonical}` }])
      }
      if (url.includes(`19%3A${canonical}_${self}%40unq.gbl.spaces`)) {
        return jsonResponse({ id: `19:${canonical}_${self}@unq.gbl.spaces` })
      }
      return jsonResponse({}, { status: 404 })
    })

    const resolved = await resolveFederatedEquivalentConversationId(self, selected)

    expect(resolved).toBe(`19:${canonical}_${self}@unq.gbl.spaces`)
    expect(urls[1]).toContain(`19%3A${canonical}_${self}%40unq.gbl.spaces`)
  })
})
