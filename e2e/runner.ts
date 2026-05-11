#!/usr/bin/env bun
// e2e test runner.
//
// Discovers files in e2e/tests/, runs each against the real owa-piggy
// profile, and prints a pass/fail/skip summary. Each test gets a
// per-test log tail of .tmp/events.log + .tmp/network.log so failures
// show what teaminal recorded during the run.
//
// Usage:
//   bun run e2e                          # all read-only tests, default profile
//   bun run e2e -- --profile work        # explicit owa-piggy profile
//   bun run e2e -- --filter chats        # run only tests with "chats" in name
//   bun run e2e -- --external-users a@x,b@y   # for federation/search tests
//   TEAMINAL_E2E_MUTATING=1 bun run e2e        # also run mutating tests
//
// Defaults can be set via env: TEAMINAL_E2E_PROFILE,
// TEAMINAL_E2E_EXTERNAL_USERS (comma-separated).
//
// Tests are READ-ONLY unless they opt in via { mutating: true }, and
// mutating tests refuse to run without the env var. We don't want a
// stray test run to spam someone's actual chat history.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setActiveProfile } from '../src/graph/client'
import { EVENTS_LOG, NETWORK_LOG, installLogging, logFileSize, tailFromOffset } from './log'
import type { E2EContext, E2ETest } from './types'

const DEFAULT_PROFILE = process.env.TEAMINAL_E2E_PROFILE || 'default'
const DEFAULT_EXTERNAL_USERS = (process.env.TEAMINAL_E2E_EXTERNAL_USERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

type CliArgs = {
  profile: string
  filter?: string
  externalUsers: string[]
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { profile: DEFAULT_PROFILE, externalUsers: DEFAULT_EXTERNAL_USERS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile' || a === '-p') {
      const v = argv[i + 1]
      if (!v) {
        console.error('e2e: --profile requires a value')
        process.exit(2)
      }
      out.profile = v
      i++
    } else if (a === '--filter' || a === '-f') {
      const v = argv[i + 1]
      if (!v) {
        console.error('e2e: --filter requires a value')
        process.exit(2)
      }
      out.filter = v
      i++
    } else if (a === '--external-users') {
      const v = argv[i + 1]
      if (!v) {
        console.error('e2e: --external-users requires a comma-separated list')
        process.exit(2)
      }
      out.externalUsers = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      i++
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        [
          'usage: bun run e2e [-- --profile <p>] [--filter <substr>] [--external-users a@b,c@d]',
          'env: TEAMINAL_E2E_MUTATING=1 enables mutating tests',
        ].join('\n') + '\n',
      )
      process.exit(0)
    } else {
      console.error(`e2e: unknown argument: ${a}`)
      process.exit(2)
    }
  }
  return out
}

async function loadTests(): Promise<{ path: string; module: { default: E2ETest } }[]> {
  const dir = join(import.meta.dir, 'tests')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.e2e.ts'))
    .sort()
  const out: { path: string; module: { default: E2ETest } }[] = []
  for (const f of files) {
    const path = join(dir, f)
    const module = (await import(path)) as { default: E2ETest }
    if (!module.default || typeof module.default.run !== 'function') {
      console.warn(`e2e: ${f} has no default-exported test, skipping`)
      continue
    }
    out.push({ path, module })
  }
  return out
}

type ResultStatus = 'pass' | 'fail' | 'skip'

type Result = {
  name: string
  status: ResultStatus
  durationMs: number
  reason?: string
  error?: Error
  newEventLogLines: string[]
  newNetworkLogLines: string[]
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
}

function color(stream: NodeJS.WriteStream, text: string, code: string): string {
  if (!stream.isTTY) return text
  return `${code}${text}${ANSI.reset}`
}

async function runOne(test: E2ETest, ctx: E2EContext): Promise<Result> {
  const startedAt = Date.now()
  const eventsStart = logFileSize(EVENTS_LOG)
  const networkStart = logFileSize(NETWORK_LOG)
  if (test.skip) {
    const reason = test.skip(ctx)
    if (reason) {
      return {
        name: test.name,
        status: 'skip',
        durationMs: 0,
        reason,
        newEventLogLines: [],
        newNetworkLogLines: [],
      }
    }
  }
  if (test.mutating && process.env.TEAMINAL_E2E_MUTATING !== '1') {
    return {
      name: test.name,
      status: 'skip',
      durationMs: 0,
      reason: 'mutating tests gated by TEAMINAL_E2E_MUTATING=1',
      newEventLogLines: [],
      newNetworkLogLines: [],
    }
  }
  try {
    await test.run(ctx)
    const newEventLogLines = await tailFromOffset(EVENTS_LOG, eventsStart)
    const newNetworkLogLines = await tailFromOffset(NETWORK_LOG, networkStart)
    return {
      name: test.name,
      status: 'pass',
      durationMs: Date.now() - startedAt,
      newEventLogLines,
      newNetworkLogLines,
    }
  } catch (err) {
    const newEventLogLines = await tailFromOffset(EVENTS_LOG, eventsStart)
    const newNetworkLogLines = await tailFromOffset(NETWORK_LOG, networkStart)
    return {
      name: test.name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err : new Error(String(err)),
      newEventLogLines,
      newNetworkLogLines,
    }
  }
}

function formatLines(lines: string[], indent: string, max = 30): string {
  if (lines.length === 0) return `${indent}(no entries)`
  const head = lines.length > max ? lines.slice(-max) : lines
  return head.map((l) => `${indent}${l}`).join('\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  installLogging()
  setActiveProfile(args.profile)

  const tests = await loadTests()
  const filtered = args.filter
    ? tests.filter(({ module }) =>
        module.default.name.toLowerCase().includes(args.filter!.toLowerCase()),
      )
    : tests

  if (filtered.length === 0) {
    console.error('e2e: no tests matched')
    process.exit(2)
  }

  console.log(
    color(
      process.stdout,
      `\nteaminal e2e · profile=${args.profile} · external=[${args.externalUsers.join(', ')}]`,
      ANSI.bold,
    ),
  )
  console.log(`logs: ${EVENTS_LOG}, ${NETWORK_LOG}\n`)

  const ctx: E2EContext = {
    profile: args.profile,
    externalUsers: args.externalUsers,
    log: (msg) => console.log(`  ${color(process.stdout, '·', ANSI.dim)} ${msg}`),
  }

  const results: Result[] = []
  for (const { module } of filtered) {
    const test = module.default
    const header = `${test.name}${test.mutating ? ' [mutating]' : ''}`
    process.stdout.write(`${color(process.stdout, '▶', ANSI.cyan)} ${header}\n`)
    if (test.description) {
      process.stdout.write(`  ${color(process.stdout, test.description, ANSI.dim)}\n`)
    }
    const result = await runOne(test, ctx)
    results.push(result)
    if (result.status === 'pass') {
      console.log(`  ${color(process.stdout, 'PASS', ANSI.green)} ${result.durationMs}ms\n`)
    } else if (result.status === 'skip') {
      console.log(`  ${color(process.stdout, 'SKIP', ANSI.yellow)} ${result.reason ?? ''}\n`)
    } else {
      console.log(`  ${color(process.stdout, 'FAIL', ANSI.red)} ${result.durationMs}ms`)
      if (result.error) {
        console.log(`  ${color(process.stdout, result.error.message, ANSI.red)}`)
        if (result.error.stack) {
          const lines = result.error.stack.split('\n').slice(1, 6)
          for (const l of lines) console.log(`    ${color(process.stdout, l.trim(), ANSI.dim)}`)
        }
      }
      console.log(`  ${color(process.stdout, 'events.log:', ANSI.dim)}`)
      console.log(formatLines(result.newEventLogLines, '    ', 20))
      console.log(`  ${color(process.stdout, 'network.log:', ANSI.dim)}`)
      console.log(formatLines(result.newNetworkLogLines, '    ', 20))
      console.log()
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const skipped = results.filter((r) => r.status === 'skip').length
  const summary = `${passed} passed, ${failed} failed, ${skipped} skipped`
  console.log(
    color(process.stdout, summary, failed > 0 ? ANSI.red : passed > 0 ? ANSI.green : ANSI.yellow),
  )

  process.exit(failed > 0 ? 1 : 0)
}

void main()
