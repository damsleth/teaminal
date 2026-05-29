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
import type { Chat, ChatMessage } from '../types'
import {
  emptyMessageCache,
  messagesFromCaches,
  type AppState,
  type Store,
} from './store'

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
        id: 'seed-member-nina',
        displayName: 'Nina',
        email: 'nina@example.com',
        userId: 'seed-user-nina',
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
      body: { contentType: 'text', content: 'Nina shared two compact layout options.' },
      from: { user: { id: 'seed-user-nina', displayName: 'Nina' } },
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
      from: { user: { id: 'seed-user-nina', displayName: 'Nina' } },
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the app should run in seeded/offline mode.
 * Triggered by TEAMINAL_SEED=fixtures (or any truthy value).
 */
export function isSeededMode(): boolean {
  const v = process.env.TEAMINAL_SEED
  return typeof v === 'string' && v.length > 0
}

/**
 * Populate the store with deterministic seed data and mark the session
 * as fully online so the UI renders the full chat chrome. No Graph calls
 * are made; no owa-piggy auth is required.
 */
export function applySeededState(store: Store<AppState>): void {
  const messageCacheByConvo: AppState['messageCacheByConvo'] = {}
  for (const [key, msgs] of Object.entries(SEED_MESSAGES)) {
    messageCacheByConvo[key] = emptyMessageCache(msgs)
  }

  store.set({
    me: SEED_ME,
    capabilities: SEED_CAPABILITIES,
    chats: SEED_CHATS,
    teams: [],
    channelsByTeam: {},
    messageCacheByConvo,
    messagesByConvo: messagesFromCaches(messageCacheByConvo),
    conn: 'online',
    realtimeState: 'off',
  })
}
