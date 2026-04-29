// Live smoke for src/graph/chats.listChats.
//
// Prints the most recent N chats with topic, type, and last-message preview
// timestamp. Use to confirm $orderby=lastMessagePreview/createdDateTime works
// against the user's tenant.

import { setActiveProfile } from '../src/graph/client'
import { listChats } from '../src/graph/chats'

const profile = Bun.argv[2]
if (profile) setActiveProfile(profile)

const top = 10
const t0 = performance.now()
const chats = await listChats({ top })
const elapsed = performance.now() - t0

process.stdout.write(`fetched ${chats.length} chats in ${elapsed.toFixed(0)}ms\n\n`)

for (const c of chats) {
  const last = c.lastMessagePreview
  const topic = c.topic ?? '(no topic)'
  const lastTime = last?.createdDateTime ?? '-'
  const preview = last?.body?.content?.slice(0, 60).replace(/\s+/g, ' ').trim() ?? ''
  const sender = last?.from?.user?.displayName ?? ''
  process.stdout.write(
    `[${c.chatType.padEnd(8)}] ${lastTime}  ${topic}\n` +
      (preview ? `  -> ${sender}: ${preview}\n` : ''),
  )
}
