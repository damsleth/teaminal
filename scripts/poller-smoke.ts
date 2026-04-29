// Live smoke for src/state/poller.
//
// Wires the capability probe + me + poller together, waits ~6s, prints
// store state, and stops cleanly. This is the first end-to-end exercise
// of the active+list+presence loops against real Graph.

import { setActiveProfile } from '../src/graph/client'
import { probeCapabilities } from '../src/graph/capabilities'
import { getMe } from '../src/graph/me'
import { startPoller, type MentionEvent } from '../src/state/poller'
import { createAppStore } from '../src/state/store'

const profile = Bun.argv[2]
if (profile) setActiveProfile(profile)

const store = createAppStore()
const me = await getMe()
store.set({ me })
const capabilities = await probeCapabilities()
store.set({ capabilities })

process.stdout.write('Capabilities:\n')
for (const [area, r] of Object.entries(capabilities)) {
  process.stdout.write(`  ${area.padEnd(12)}  ${r.ok ? 'OK' : `${r.reason} ${r.status ?? ''}`}\n`)
}

const mentions: MentionEvent[] = []
const errors: { loop: string; msg: string }[] = []

const handle = startPoller({
  store,
  intervals: { activeMs: 5_000, listMs: 5_000, presenceMs: 8_000 },
  onMention: (e) => mentions.push(e),
  onError: (loop, err) => errors.push({ loop, msg: err.message }),
})

// Pick the most-recent chat as the active focus once the list loop has run
let focusedChosen = false
const unsub = store.subscribe((s) => {
  if (!focusedChosen && s.chats.length > 0) {
    focusedChosen = true
    const chat = s.chats[0]
    if (chat) {
      process.stdout.write(`\nfocusing on chat ${chat.id} (${chat.topic ?? '(no topic)'})\n`)
      store.set({ focus: { kind: 'chat', chatId: chat.id } })
    }
  }
})

await Bun.sleep(6_000)

unsub()
await handle.stop()

const s = store.get()
process.stdout.write(`\n=== After 6s ===\n`)
process.stdout.write(`conn=${s.conn}\n`)
process.stdout.write(`chats=${s.chats.length}\n`)
process.stdout.write(`teams=${s.teams.length}\n`)
process.stdout.write(`channelsByTeam keys=${Object.keys(s.channelsByTeam).length}\n`)
process.stdout.write(`messagesByConvo keys=${Object.keys(s.messagesByConvo).join(', ') || '(none)'}\n`)
const activeKey = Object.keys(s.messagesByConvo)[0]
if (activeKey) {
  process.stdout.write(`active conv message count=${s.messagesByConvo[activeKey]?.length ?? 0}\n`)
}
process.stdout.write(`myPresence=${s.myPresence ? `${s.myPresence.availability}/${s.myPresence.activity}` : '(none)'}\n`)
process.stdout.write(`onMention events=${mentions.length}\n`)
if (errors.length > 0) {
  process.stdout.write(`errors=${errors.length}\n`)
  for (const e of errors.slice(0, 5)) process.stdout.write(`  ${e.loop}: ${e.msg}\n`)
}
