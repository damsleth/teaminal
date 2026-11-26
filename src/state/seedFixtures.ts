// Deterministic seed data for the TEAMINAL_SEED=fixtures offline mode.
//
// When bin/teaminal.tsx detects TEAMINAL_SEED=fixtures it calls
// applySeededState() to populate the store with these fixed chats and
// messages, then skips all Graph / owa-piggy calls. No auth required.
//
// The data mirrors the same conversations that scripts/tui-fixture.js
// used to render (now deleted); keeping the same names preserves any
// existing tui-test snapshot expectations.

import type { Me } from '../graph/me'
import type { Capabilities } from '../graph/capabilities'
import type { Channel, Chat, ChatMessage, Team } from '../types'
import type { AccountStore } from './accountStore'
import { emptyMessageCache, messagesFromCaches, type AppState } from './store'

// ---------------------------------------------------------------------------
// Fixed identity
// ---------------------------------------------------------------------------

export const SEED_ME: Me = {
  id: 'seed-user-00000000-0000-0000-0000-000000000001',
  displayName: 'You',
  userPrincipalName: 'you@example.com',
  mail: 'you@example.com',
}

// ---------------------------------------------------------------------------
// Fixed capabilities (all green so the UI shows the full chrome)
// ---------------------------------------------------------------------------

export const SEED_CAPABILITIES: Capabilities = {
  me: { ok: true },
  chats: { ok: true },
  joinedTeams: { ok: true },
  presence: { ok: true },
}

// ---------------------------------------------------------------------------
// Fixed chats
// ---------------------------------------------------------------------------

const T0 = '2026-05-29T09:00:00.000Z'
const T1 = '2026-05-29T09:01:00.000Z'
const T2 = '2026-05-29T09:02:00.000Z'

export const SEED_CHATS: Chat[] = [
  {
    id: 'seed-chat-ada',
    chatType: 'oneOnOne',
    createdDateTime: T0,
    lastUpdatedDateTime: T1,
    topic: null,
    members: [
      {
        id: 'seed-member-ada',
        displayName: 'Ada Byron',
        email: 'ada@example.com',
        userId: 'seed-user-ada',
      },
      {
        id: 'seed-member-you',
        displayName: 'You',
        email: 'you@example.com',
        userId: SEED_ME.id,
      },
    ],
    lastMessagePreview: {
      id: 'seed-msg-ada-2',
      createdDateTime: T1,
      body: { contentType: 'text', content: 'The launch notes are ready for review.' },
      from: { user: { id: 'seed-user-ada', displayName: 'Ada Byron' } },
    },
  },
  {
    id: 'seed-chat-design-sync',
    chatType: 'group',
    createdDateTime: T0,
    lastUpdatedDateTime: T1,
    topic: 'Design Sync',
    members: [
      {
        id: 'seed-member-anna',
        displayName: 'Anna',
        email: 'anna@example.com',
        userId: 'seed-user-anna',
      },
      {
        id: 'seed-member-kai',
        displayName: 'Kai',
        email: 'kai@example.com',
        userId: 'seed-user-kai',
      },
      {
        id: 'seed-member-you2',
        displayName: 'You',
        email: 'you@example.com',
        userId: SEED_ME.id,
      },
    ],
    lastMessagePreview: {
      id: 'seed-msg-design-2',
      createdDateTime: T1,
      body: { contentType: 'text', content: 'Anna shared two compact layout options.' },
      from: { user: { id: 'seed-user-anna', displayName: 'Anna' } },
    },
  },
  {
    id: 'seed-chat-ops',
    chatType: 'group',
    createdDateTime: T0,
    lastUpdatedDateTime: T2,
    topic: 'Ops Channel',
    members: [
      {
        id: 'seed-member-mina',
        displayName: 'Mina',
        email: 'mina@example.com',
        userId: 'seed-user-mina',
      },
      {
        id: 'seed-member-you3',
        displayName: 'You',
        email: 'you@example.com',
        userId: SEED_ME.id,
      },
    ],
    lastMessagePreview: {
      id: 'seed-msg-ops-2',
      createdDateTime: T2,
      body: { contentType: 'text', content: 'Deploy is green in the EU region.' },
      from: { user: { id: 'seed-user-mina', displayName: 'Mina' } },
    },
  },
]

// ---------------------------------------------------------------------------
// Fixed messages per chat
// ---------------------------------------------------------------------------

const SEED_MESSAGES: Record<string, ChatMessage[]> = {
  'chat:seed-chat-ada': [
    {
      id: 'seed-msg-ada-1',
      createdDateTime: T0,
      chatId: 'seed-chat-ada',
      messageType: 'message',
      body: { contentType: 'text', content: 'I will read them now.' },
      from: { user: { id: SEED_ME.id, displayName: 'You' } },
    },
    {
      id: 'seed-msg-ada-2',
      createdDateTime: T1,
      chatId: 'seed-chat-ada',
      messageType: 'message',
      body: { contentType: 'text', content: 'The launch notes are ready for review.' },
      from: { user: { id: 'seed-user-ada', displayName: 'Ada Byron' } },
    },
  ],
  'chat:seed-chat-design-sync': [
    {
      id: 'seed-msg-design-1',
      createdDateTime: T0,
      chatId: 'seed-chat-design-sync',
      messageType: 'message',
      body: { contentType: 'text', content: 'Two compact layout options landed.' },
      from: { user: { id: 'seed-user-anna', displayName: 'Anna' } },
    },
    {
      id: 'seed-msg-design-2',
      createdDateTime: T1,
      chatId: 'seed-chat-design-sync',
      messageType: 'message',
      body: { contentType: 'text', content: 'The second one scans faster.' },
      from: { user: { id: 'seed-user-kai', displayName: 'Kai' } },
    },
  ],
  'chat:seed-chat-ops': [
    {
      id: 'seed-msg-ops-1',
      createdDateTime: T1,
      chatId: 'seed-chat-ops',
      messageType: 'message',
      body: { contentType: 'text', content: 'Deploy is green in the EU region.' },
      from: { user: { id: 'seed-user-mina', displayName: 'Mina' } },
    },
    {
      id: 'seed-msg-ops-2',
      createdDateTime: T2,
      chatId: 'seed-chat-ops',
      messageType: 'message',
      body: { contentType: 'text', content: 'Good, leave the monitor open.' },
      from: { user: { id: SEED_ME.id, displayName: 'You' } },
    },
  ],
}

// ---------------------------------------------------------------------------
// Channel fixtures (TEAMINAL_SEED=channels only)
// ---------------------------------------------------------------------------
//
// One team, one channel, one flat stream the way the chatsvc normalizer
// returns it: a root carries rootMessageId === id and no replyToId; a reply
// carries both, pointing at its root. Two roots (the newer one with two
// replies, the older one with one) plus a reply whose root is not loaded. The
// cache stays incomplete, so the reply badges read "N+".

export const SEED_TEAM_ID = 'seed-team-contoso'
export const SEED_CHANNEL_ID = 'seed-channel-launch'
export const SEED_CHANNEL_CONV = `channel:${SEED_TEAM_ID}:${SEED_CHANNEL_ID}`

const SEED_TEAMS: Team[] = [{ id: SEED_TEAM_ID, displayName: 'Contoso' }]
const SEED_CHANNELS: Record<string, Channel[]> = {
  [SEED_TEAM_ID]: [{ id: SEED_CHANNEL_ID, displayName: 'Launch' }],
}

const KARI = { id: 'seed-user-kari', displayName: 'Kari Nordmann' }
const BOB = { id: 'seed-user-bob', displayName: 'Bob' }
const ALICE = { id: 'seed-user-alice', displayName: 'Alice' }

function channelMessage(
  id: string,
  minute: number,
  user: { id: string; displayName: string },
  content: string,
  rootId = id,
): ChatMessage {
  return {
    id,
    createdDateTime: `2026-05-29T10:${String(minute).padStart(2, '0')}:00.000Z`,
    messageType: 'message',
    body: { contentType: 'text', content },
    from: { user },
    rootMessageId: rootId,
    ...(rootId === id ? {} : { replyToId: rootId }),
  }
}

const SEED_CHANNEL_MESSAGES: ChatMessage[] = [
  channelMessage('seed-ch-orphan', 0, BOB, 'Picking up the old thread here.', 'seed-ch-unloaded'),
  channelMessage('seed-ch-root-1', 1, KARI, 'Venue for the offsite is booked.'),
  channelMessage('seed-ch-r1-a', 2, ALICE, 'Great, I will sort the travel.', 'seed-ch-root-1'),
  channelMessage('seed-ch-root-2', 3, ALICE, 'Release notes draft is up.'),
  channelMessage('seed-ch-r2-a', 4, BOB, 'Added the migration section.', 'seed-ch-root-2'),
  channelMessage('seed-ch-r2-b', 5, KARI, 'Looks good to ship.', 'seed-ch-root-2'),
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the app should run in seeded/offline mode.
 * Triggered by TEAMINAL_SEED=fixtures (or any truthy value). The value
 * `channels` also seeds the channel fixtures.
 */
export function isSeededMode(): boolean {
  const v = process.env.TEAMINAL_SEED
  return typeof v === 'string' && v.length > 0
}

// Collision fixtures (M2): the profiles named BETA_PROFILE and GAMMA_PROFILE
// reuse every fixture id (me, chats, members, messages) with different text:
// beta upper-cases names, topics and bodies, gamma appends " (gamma)" (not a
// case change, so a filter tells all three apart). Text of one account on
// screen under another is a cross-account leak. Other profiles get the normal
// fixtures.
export const BETA_PROFILE = 'beta'
export const GAMMA_PROFILE = 'gamma'
const TEXT_VARIANTS = new Map<string, (text: string) => string>([
  [BETA_PROFILE, (t) => t.toUpperCase()],
  [GAMMA_PROFILE, (t) => `${t} (gamma)`],
])
const VARIANT_TEXT_KEYS = new Set(['displayName', 'topic', 'content'])
function textVariant<T>(value: T, f: (text: string) => string): T {
  if (Array.isArray(value)) return value.map((v) => textVariant(v, f)) as T
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = VARIANT_TEXT_KEYS.has(k) && typeof v === 'string' ? f(v) : textVariant(v, f)
  }
  return out as T
}

/**
 * Populate the store with deterministic seed data and mark the session
 * as fully online so the UI renders the full chat chrome. No Graph calls
 * are made; no owa-piggy auth is required.
 */
export function applySeededState(acc: AccountStore, profile?: string | null): void {
  const variant = profile ? TEXT_VARIANTS.get(profile) : undefined
  const pick = <T>(v: T): T => (variant ? textVariant(v, variant) : v)
  const channels = process.env.TEAMINAL_SEED === 'channels'
  const messageCacheByConvo: AppState['messageCacheByConvo'] = {}
  for (const [key, msgs] of Object.entries(SEED_MESSAGES)) {
    messageCacheByConvo[key] = emptyMessageCache(pick(msgs))
  }
  if (channels) {
    messageCacheByConvo[SEED_CHANNEL_CONV] = emptyMessageCache(pick(SEED_CHANNEL_MESSAGES))
  }

  acc.set({
    me: pick(SEED_ME),
    capabilities: SEED_CAPABILITIES,
    chats: pick(SEED_CHATS),
    teams: channels ? pick(SEED_TEAMS) : [],
    channelsByTeam: channels ? pick(SEED_CHANNELS) : {},
    messageCacheByConvo,
    messagesByConvo: messagesFromCaches(messageCacheByConvo),
    conn: 'online',
    realtimeState: 'off',
  })
}
