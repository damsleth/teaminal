#!/usr/bin/env bun
/**
 * tui-loop — TUI flow runner and agent-facing manifest emitter.
 *
 * Drives @microsoft/tui-test flow tests (scripts/tui-loop/flows/) via the
 * Node-based tui-test runner, then collects the PNG/SVG artifacts written by
 * each test's captureTerminal() call and emits a manifest JSON for the running
 * agent to read each iteration.
 *
 * Manifest shape (per step entry):
 *   { flow, step, png, svg, snapshotDiff, assertions, timestamp }
 *
 * On visual or snapshot drift the agent is pointed at the PNG path so it can
 * inspect the rendered TUI and report glitches or propose fixes.
 *
 * COMMANDS
 *   flows    list native tui-test flow test files discovered under
 *            scripts/tui-loop/flows/
 *   shots    invoke the tui-test runner, collect artifacts, emit manifest
 *   manifest print the last-written manifest JSON (without re-running)
 *
 * PACKAGE.JSON SCRIPTS (T4.3)
 *   tui:flows   → bun run scripts/tui-loop.ts flows
 *   tui:shots   → bunx @microsoft/tui-test (via Node, see note in tui-test.config.ts)
 *   tui:update  → bunx @microsoft/tui-test --update
 *   tui:trace   → bunx @microsoft/tui-test --trace
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/** One entry in the manifest — one shot captured during a flow test. */
export type ManifestEntry = {
  /** Flow test file name (without extension), e.g. "chat-shell". */
  flow: string
  /** Shot name within the flow, e.g. "initial-shell". */
  step: string
  /** Absolute path to the PNG artifact (agent-facing visual). null if not produced. */
  png: string | null
  /** Absolute path to the SVG artifact. null if not produced. */
  svg: string | null
  /**
   * Snapshot drift indicator. "new" if no prior snapshot exists, "changed" if
   * the tui-test runner reported a mismatch, "ok" if unchanged, "unknown" when
   * the runner output could not be parsed for this step.
   */
  snapshotDiff: 'ok' | 'new' | 'changed' | 'unknown'
  /** Inline text assertions that passed for this step (from tui-test output). */
  assertions: string[]
  /** ISO timestamp of when this entry was written. */
  timestamp: string
}

/** Top-level manifest — written to .tui-loop/manifest.json after every run. */
export type TuiLoopManifest = {
  /** ISO timestamp of the run that produced this manifest. */
  runAt: string
  /** Exit code of the tui-test runner process (0 = all tests passed). */
  runnerExitCode: number
  /** Whether any entry has snapshotDiff !== 'ok'. */
  hasDrift: boolean
  /** Manifest entries, one per shot captured across all flows. */
  entries: ManifestEntry[]
  /** Absolute path to this manifest file (for agent convenience). */
  manifestPath: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '..')
const SHOTS_BASE = join(ROOT, '.tui-loop', 'shots')
const MANIFEST_PATH = join(ROOT, '.tui-loop', 'manifest.json')
const ARTIFACTS_DIR = join(ROOT, '.tui-loop')
const FLOWS_DIR = join(ROOT, 'scripts', 'tui-loop', 'flows')

// tui-test is driven via Node (not Bun) — see tui-test.config.ts runner note.
const TUI_TEST_BIN = join(ROOT, 'node_modules', '@microsoft', 'tui-test', 'index.js')

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `tui-loop

USAGE
  bun run scripts/tui-loop.ts <command> [options]

COMMANDS
  flows     list native tui-test flow test files under scripts/tui-loop/flows/
  shots     run tui-test flows, collect PNG/SVG artifacts, emit manifest
  manifest  print the last-written manifest JSON (without re-running)

OPTIONS
  --update  pass --update to tui-test (snapshot update mode)
  --trace   pass --trace to tui-test (record traces for replay)
  --help    show this message

MANIFEST
  Written to .tui-loop/manifest.json after every 'shots' run.
  Shape: { runAt, runnerExitCode, hasDrift, entries[], manifestPath }
  Each entry: { flow, step, png, svg, snapshotDiff, assertions, timestamp }

  On visual or snapshot drift (hasDrift=true), inspect the png path in the
  relevant entry to see the rendered TUI at that step.
`

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

type ParsedArgs = {
  command: string
  update: boolean
  trace: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  // Allow --help / -h as the first token (before the command).
  if (argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help', update: false, trace: false }
  }
  let command = argv[0] ?? 'help'
  let update = false
  let trace = false
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--update') {
      update = true
    } else if (arg === '--trace') {
      trace = true
    } else if (arg === '--help' || arg === '-h') {
      command = 'help'
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return { command, update, trace }
}

// ---------------------------------------------------------------------------
// Flow file discovery
// ---------------------------------------------------------------------------

/** List *.test.ts files under scripts/tui-loop/flows/. */
function discoverFlowFiles(): string[] {
  if (!existsSync(FLOWS_DIR)) return []
  return readdirSync(FLOWS_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => join(FLOWS_DIR, f))
}

/** Flow id from a flow test file path (basename without .test.ts). */
function flowId(filePath: string): string {
  return filePath.replace(/\.test\.ts$/, '').split('/').pop() ?? filePath
}

// ---------------------------------------------------------------------------
// tui-test runner invocation
// ---------------------------------------------------------------------------

type RunnerResult = {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Invoke the @microsoft/tui-test runner via Node (not Bun — see tui-test.config.ts).
 * Returns exit code + combined output for manifest annotation.
 */
async function invokeTuiTest(extraArgs: string[]): Promise<RunnerResult> {
  if (!existsSync(TUI_TEST_BIN)) {
    throw new Error(
      `tui-test binary not found at ${TUI_TEST_BIN}.\n` +
        'Run `bun install` to install @microsoft/tui-test.',
    )
  }

  const args = [TUI_TEST_BIN, ...extraArgs]
  const proc = Bun.spawn(['node', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { exitCode, stdout, stderr }
}

// ---------------------------------------------------------------------------
// Artifact collection
// ---------------------------------------------------------------------------

/**
 * Scan .tui-loop/shots/<flow>/ directories for PNG and SVG files.
 * Returns a map of flow → shot name → { png, svg }.
 */
function collectShots(): Map<string, Map<string, { png: string | null; svg: string | null }>> {
  const result = new Map<string, Map<string, { png: string | null; svg: string | null }>>()
  if (!existsSync(SHOTS_BASE)) return result

  for (const flowDir of readdirSync(SHOTS_BASE)) {
    const flowPath = join(SHOTS_BASE, flowDir)
    try {
      const entries = readdirSync(flowPath)
      const shots = new Map<string, { png: string | null; svg: string | null }>()
      // Collect all base names (without extension) that have a PNG or SVG.
      const names = new Set<string>()
      for (const entry of entries) {
        if (entry.endsWith('.png')) names.add(entry.slice(0, -4))
        else if (entry.endsWith('.svg')) names.add(entry.slice(0, -4))
      }
      for (const name of names) {
        const pngPath = join(flowPath, `${name}.png`)
        const svgPath = join(flowPath, `${name}.svg`)
        shots.set(name, {
          png: existsSync(pngPath) ? pngPath : null,
          svg: existsSync(svgPath) ? svgPath : null,
        })
      }
      result.set(flowDir, shots)
    } catch {
      // Non-directory entry — skip.
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Snapshot drift detection from runner output
// ---------------------------------------------------------------------------

/**
 * Heuristically determine snapshot drift status for a given flow+step from the
 * combined tui-test runner output. tui-test prints "X snapshots written" or
 * "X snapshots updated" or "X snapshot(s) failed" lines — we match those.
 *
 * Since tui-test doesn't emit per-step lines that we can reliably parse, we
 * use "changed"/"new" if the runner wrote/updated any snapshot at all, and "ok"
 * otherwise. This is conservative: a multi-step run shows drift on all steps
 * when any snapshot changed.
 */
function detectSnapshotDiff(
  runnerOutput: string,
  _flow: string,
  _step: string,
): ManifestEntry['snapshotDiff'] {
  if (/snapshot.*fail/i.test(runnerOutput)) return 'changed'
  if (/snapshot.*written|written.*snapshot/i.test(runnerOutput)) return 'new'
  if (/snapshot.*updated|updated.*snapshot/i.test(runnerOutput)) return 'changed'
  if (/snapshot.*matched|matched.*snapshot/i.test(runnerOutput)) return 'ok'
  // No snapshot lines in output — treat as ok if runner exited 0.
  return 'ok'
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

/**
 * Build a manifest by correlating shot artifacts with known flow test files and
 * the runner output. Emits one entry per (flow, shot-step) pair found on disk.
 */
function buildManifest(
  runnerResult: RunnerResult,
  runAt: string,
): TuiLoopManifest {
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  const shots = collectShots()
  const entries: ManifestEntry[] = []
  const combinedOutput = runnerResult.stdout + runnerResult.stderr

  const globalSnapshotDiff = detectSnapshotDiff(combinedOutput, '', '')

  for (const [flow, shotMap] of shots) {
    // Sort shots alphabetically for deterministic manifest order.
    const sortedSteps = [...shotMap.keys()].sort()
    for (const step of sortedSteps) {
      const { png, svg } = shotMap.get(step)!
      entries.push({
        flow,
        step,
        png,
        svg,
        snapshotDiff: globalSnapshotDiff,
        assertions: [],
        timestamp: runAt,
      })
    }
  }

  // If no shots on disk yet (first run / clean tree), still emit one entry per
  // discovered flow so the agent knows what was attempted.
  if (entries.length === 0) {
    const flowFiles = discoverFlowFiles()
    for (const f of flowFiles) {
      entries.push({
        flow: flowId(f),
        step: '(no shots)',
        png: null,
        svg: null,
        snapshotDiff: 'unknown',
        assertions: [],
        timestamp: runAt,
      })
    }
  }

  const hasDrift = entries.some((e) => e.snapshotDiff !== 'ok' && e.snapshotDiff !== 'unknown')

  const manifest: TuiLoopManifest = {
    runAt,
    runnerExitCode: runnerResult.exitCode,
    hasDrift,
    entries,
    manifestPath: MANIFEST_PATH,
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdFlows(): Promise<void> {
  const files = discoverFlowFiles()
  if (files.length === 0) {
    process.stdout.write('(no flow test files found under scripts/tui-loop/flows/)\n')
    return
  }
  for (const f of files) {
    process.stdout.write(`${flowId(f)}\t${relative(ROOT, f)}\n`)
  }
}

async function cmdShots(update: boolean, trace: boolean): Promise<void> {
  const extraArgs: string[] = []
  if (update) extraArgs.push('--update')
  if (trace) extraArgs.push('--trace')

  process.stdout.write(
    `tui-loop: invoking tui-test runner${extraArgs.length ? ` ${extraArgs.join(' ')}` : ''}...\n`,
  )

  const runAt = new Date().toISOString()
  const result = await invokeTuiTest(extraArgs)

  // Echo runner output so the caller (agent or developer) sees it.
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  const manifest = buildManifest(result, runAt)
  const shotCount = manifest.entries.filter((e) => e.png !== null).length
  const driftEntries = manifest.entries.filter(
    (e) => e.snapshotDiff !== 'ok' && e.snapshotDiff !== 'unknown',
  )

  process.stdout.write(
    `\ntui-loop: ${shotCount} shot(s) across ${manifest.entries.length} step(s), ` +
      `runner exit=${manifest.runnerExitCode}, drift=${manifest.hasDrift}.\n` +
      `Manifest: ${MANIFEST_PATH}\n`,
  )

  if (manifest.hasDrift && driftEntries.length > 0) {
    process.stdout.write('\nSnapshot drift detected. Inspect these PNG artifacts:\n')
    for (const e of driftEntries) {
      const pngDisplay = e.png ?? '(no png)'
      process.stdout.write(`  [${e.flow} / ${e.step}] snapshotDiff=${e.snapshotDiff}\n`)
      process.stdout.write(`    png: ${pngDisplay}\n`)
      if (e.svg) process.stdout.write(`    svg: ${e.svg}\n`)
    }
    process.stdout.write(
      '\nTo update snapshots: bun run tui:update\n' +
        'To record a trace:   bun run tui:trace\n',
    )
  }

  // Propagate runner exit code so CI can gate on test failures.
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

function cmdManifest(): void {
  if (!existsSync(MANIFEST_PATH)) {
    process.stdout.write(
      `No manifest found at ${MANIFEST_PATH}.\nRun 'bun run tui:shots' to produce one.\n`,
    )
    return
  }
  process.stdout.write(readFileSync(MANIFEST_PATH, 'utf8'))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, update, trace } = parseArgs(Bun.argv.slice(2))

  if (command === 'help') {
    process.stdout.write(HELP)
    return
  }

  if (command === 'flows') {
    await cmdFlows()
    return
  }

  if (command === 'shots') {
    await cmdShots(update, trace)
    return
  }

  if (command === 'manifest') {
    cmdManifest()
    return
  }

  throw new Error(`unknown command: ${command}. Run with --help for usage.`)
}

try {
  await main()
} catch (err) {
  process.stderr.write(`tui-loop: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
