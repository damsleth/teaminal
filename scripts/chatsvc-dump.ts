// Live raw-payload dump for the Teams chat service channel-message stream.
//
// Step 1 de-risk for .plans/channel-threading-rootmessageid-rebuild.md: the
// normalizer (skypeToChannelMessage) and the root filter both throw away the
// raw Skype shape, so we can't tell from the app what fields actually carry
// thread/root linkage. This script hits chatsvc RAW - same auth path the app
// uses (getSkypeToken + resolveRegion) - and reports, empirically:
//
//   - the union of every top-level message key and every properties.* key
//   - which field(s) point at ANOTHER message id (the threading key), found
//     by value-matching against the channel's own id set - so we discover it
//     regardless of casing (rootMessageId / rootmessageid / parentmessageid…)
//   - whether a `view` other than msnp24 is needed to surface rootMessageId
//
// Usage:
//   bun run scripts/chatsvc-dump.ts [profile] [--channel <19:…@thread.tacv2>]
//                                   [--view msnp24] [--max-channels 20]
//                                   [--page-size 50]
//
// The most reply-dense scanned channel's raw first page is written to
// .plans/chatsvc-sample.json for offline field inspection.

import { setActiveProfile } from '../src/graph/client'
import { listChannels, listJoinedTeams } from '../src/graph/teams'
import { getSkypeToken } from '../src/graph/teamsFederation'
import { resolveRegion } from '../src/graph/teamsRegion'

const TEAMS_ORIGIN = 'https://teams.microsoft.com'

// --- arg parsing -----------------------------------------------------------
// Single pass: `--name value` pairs into flags, everything else positional.
const argv = Bun.argv.slice(2)
const flags = new Map<string, string>()
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const tok = argv[i]!
  if (tok.startsWith('--')) {
    flags.set(tok.slice(2), argv[i + 1] ?? '')
    i++
  } else {
    positional.push(tok)
  }
}
const profile = positional[0]
const channelArg = flags.get('channel')
const view = flags.get('view') ?? 'msnp24'
const maxChannels = Number(flags.get('max-channels') ?? '20')
const pageSize = Number(flags.get('page-size') ?? '50')

if (profile) setActiveProfile(profile)

// --- raw chatsvc fetch (mirrors chatsvcGet + chatsvcHeaders) ---------------
function headers(skypeToken: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authentication: `skypetoken=${skypeToken}`,
    'x-skypetoken': skypeToken,
    'x-ms-client-type': 'teaminal',
    'x-ms-client-caller': 'teaminal-chatsvc-dump',
    'x-ms-client-request-type': '0',
    'x-client-ui-language': 'en-us',
  }
}

type RawMsg = Record<string, unknown> & { id?: string; properties?: Record<string, unknown> }
type RawResp = { messages?: RawMsg[]; _metadata?: Record<string, unknown> }

async function fetchRaw(
  channelId: string,
  viewStr: string,
): Promise<{ status: number; json: RawResp | null; text: string }> {
  const region = await resolveRegion({ profile })
  const token = await getSkypeToken({ profile })
  const viewQ = viewStr ? `&view=${encodeURIComponent(viewStr)}` : ''
  const url = `${TEAMS_ORIGIN}/api/chatsvc/${region}/v1/users/ME/conversations/${encodeURIComponent(
    channelId,
  )}/messages?pageSize=${pageSize}&startTime=1${viewQ}`
  const res = await fetch(url, { method: 'GET', headers: headers(token) })
  const text = await res.text()
  let json: RawResp | null = null
  try {
    json = text ? (JSON.parse(text) as RawResp) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

// --- threading-field discovery ---------------------------------------------
// A "pointer" field holds a value equal to SOME message id in the same
// channel. If it equals the message's own id => root marker; if it equals a
// different message's id => reply marker. We scan both top-level and
// properties.* so we find the linkage no matter what it's called.
type Pointer = { key: string; loc: 'top' | 'props'; toSelf: number; toOther: number }

function discoverPointers(msgs: RawMsg[]): Pointer[] {
  const ids = new Set(msgs.map((m) => String(m.id ?? '')).filter(Boolean))
  const tally = new Map<string, Pointer>()
  const bump = (key: string, loc: 'top' | 'props', self: boolean) => {
    const k = `${loc}:${key}`
    const p = tally.get(k) ?? { key, loc, toSelf: 0, toOther: 0 }
    if (self) p.toSelf++
    else p.toOther++
    tally.set(k, p)
  }
  for (const m of msgs) {
    const selfId = String(m.id ?? '')
    const scan = (obj: Record<string, unknown> | undefined, loc: 'top' | 'props') => {
      if (!obj) return
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string' || !ids.has(v)) continue
        bump(k, loc, v === selfId)
      }
    }
    scan(m, 'top')
    scan(m.properties, 'props')
  }
  // Only keep fields that actually point somewhere; drop the message's own
  // `id` self-match noise by requiring the key name not be exactly 'id'.
  return [...tally.values()]
    .filter((p) => !(p.loc === 'top' && p.key === 'id'))
    .filter((p) => p.toSelf + p.toOther > 0)
    .sort((a, b) => b.toOther + b.toSelf - (a.toOther + a.toSelf))
}

function keyUnion(msgs: RawMsg[], loc: 'top' | 'props'): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of msgs) {
    const obj = loc === 'top' ? m : (m.properties as Record<string, unknown> | undefined)
    if (!obj) continue
    for (const k of Object.keys(obj)) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]))
}

function out(s: string) {
  process.stdout.write(s + '\n')
}
function grepKeys(keys: Iterable<string>, re: RegExp): string[] {
  return [...keys].filter((k) => re.test(k))
}

// --- main ------------------------------------------------------------------
try {
  // Resolve target channels.
  type Target = { team: string; teamId: string; name: string; id: string }
  let targets: Target[] = []
  if (channelArg) {
    targets = [{ team: '(arg)', teamId: '', name: '(arg)', id: channelArg }]
  } else {
    out('discovering teams + channels…')
    const teams = await listJoinedTeams()
    const per = await Promise.allSettled(
      teams.map(async (t) => ({ t, chs: await listChannels(t.id) })),
    )
    for (const r of per) {
      if (r.status !== 'fulfilled') continue
      for (const ch of r.value.chs) {
        targets.push({ team: r.value.t.displayName, teamId: r.value.t.id, name: ch.displayName, id: ch.id })
      }
    }
    out(`found ${targets.length} channels across ${teams.length} teams\n`)
  }

  const allMsgs: RawMsg[] = []
  const scanned: { tgt: Target; msgs: RawMsg[]; pointers: Pointer[]; replyish: number }[] = []

  for (const tgt of targets.slice(0, maxChannels)) {
    try {
      const { status, json } = await fetchRaw(tgt.id, view)
      const msgs = json?.messages ?? []
      if (status !== 200) {
        out(`! ${tgt.team} / ${tgt.name}: HTTP ${status}`)
        continue
      }
      const pointers = discoverPointers(msgs)
      const replyish = Math.max(0, ...pointers.map((p) => p.toOther), 0)
      scanned.push({ tgt, msgs, pointers, replyish })
      allMsgs.push(...msgs)
      out(`· ${tgt.team} / ${tgt.name}: ${msgs.length} msgs, reply-pointers=${replyish}`)
    } catch (err) {
      out(`! ${tgt.team} / ${tgt.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (allMsgs.length === 0) {
    out('\nNo messages fetched. Check auth (skype token) / profile / channel id.')
    process.exit(1)
  }

  // Global key unions.
  out('\n=== union of TOP-LEVEL message keys (key × count) ===')
  for (const [k, n] of keyUnion(allMsgs, 'top')) out(`  ${k.padEnd(28)} ${n}`)
  out('\n=== union of properties.* keys (key × count) ===')
  for (const [k, n] of keyUnion(allMsgs, 'props')) out(`  ${k.padEnd(28)} ${n}`)

  // Highlight the threading-relevant keys by pattern.
  const topKeys = [...keyUnion(allMsgs, 'top').keys()]
  const propKeys = [...keyUnion(allMsgs, 'props').keys()]
  const re = /root|seq|parent|reply|thread/i
  out('\n=== threading-relevant key names (regex root|seq|parent|reply|thread) ===')
  out(`  top-level : ${grepKeys(topKeys, re).join(', ') || '(none)'}`)
  out(`  properties: ${grepKeys(propKeys, re).join(', ') || '(none)'}`)

  // Discovered pointer fields across the whole corpus.
  out('\n=== discovered POINTER fields (value == another message id) ===')
  for (const p of discoverPointers(allMsgs)) {
    out(`  ${p.loc}:${p.key.padEnd(24)} →self=${p.toSelf}  →other=${p.toOther}`)
  }

  // Pick the most reply-dense channel for a detailed table + raw dump.
  const best = scanned.sort((a, b) => b.replyish - a.replyish)[0]
  if (best && best.replyish > 0) {
    out(`\n=== detailed thread table: ${best.tgt.team} / ${best.tgt.name} ===`)
    const ptrKeys = best.pointers.filter((p) => p.toOther > 0).map((p) => `${p.loc}:${p.key}`)
    out(`(pointer cols: ${ptrKeys.join(', ')})`)
    const get = (m: RawMsg, col: string) => {
      const [loc, key] = col.split(':')
      const obj = loc === 'top' ? m : (m.properties as Record<string, unknown> | undefined)
      return String((obj?.[key!] as unknown) ?? '·')
    }
    for (const m of best.msgs.slice(0, 30)) {
      const id = String(m.id ?? '')
      const cols = ptrKeys.map((c) => get(m, c)).join('  ')
      const subj = (m.properties?.subject as string) ?? (m.subject as string) ?? ''
      const isRoot = ptrKeys.every((c) => get(m, c) === id || get(m, c) === '·')
      out(`  ${isRoot ? 'ROOT' : 'rply'} id=${id}  ${cols}${subj ? `  «${subj.slice(0, 40)}»` : ''}`)
    }
    const samplePath = '.plans/chatsvc-sample.json'
    await Bun.write(samplePath, JSON.stringify({ channel: best.tgt, raw: best.msgs }, null, 2))
    out(`\nraw first page saved → ${samplePath}`)
  } else {
    out('\n(no reply-dense channel found in the scanned set — bump --max-channels or pass --channel)')
  }

  // View comparison: does msnp24 actually expose rootMessageId, or is another
  // view needed? Re-fetch the best (or first) channel under a few views.
  const cmpChannel = (best ?? scanned[0])?.tgt.id
  if (cmpChannel) {
    out('\n=== view comparison (top-level key presence per view) ===')
    for (const v of ['msnp24', 'supportsMessageProperties', '']) {
      try {
        const { status, json } = await fetchRaw(cmpChannel, v)
        const msgs = json?.messages ?? []
        const keys = [...keyUnion(msgs, 'top').keys()]
        const hasRoot = grepKeys(keys, /root/i)
        const hasSeq = grepKeys(keys, /seq/i)
        out(
          `  view=${(v || '(none)').padEnd(26)} HTTP ${status}  msgs=${msgs.length}  ` +
            `root-keys=[${hasRoot.join(',') || '—'}]  seq-keys=[${hasSeq.join(',') || '—'}]`,
        )
      } catch (err) {
        out(`  view=${(v || '(none)').padEnd(26)} ERROR ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  out('\nDone.')
} catch (err) {
  out(`\nFATAL: ${err instanceof Error ? err.stack || err.message : String(err)}`)
  process.exit(1)
}
