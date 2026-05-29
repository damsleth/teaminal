import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TerminalGrid } from './terminal'
import { renderGridSvg } from './svg'
import { encodeKey } from './keys'
import type { FlowConfig, FlowStep, TuiLoopConfig } from './config'

export type ManifestGroup = {
  label: string
  files: string[]
}

export type ShotsResult = {
  manifestPath: string
  groups: ManifestGroup[]
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildShellCommand(config: TuiLoopConfig): string {
  const envParts = Object.entries(config.launch.env ?? {}).map(
    ([key, value]) => `${key}=${shellQuote(value)}`,
  )
  const command = [config.launch.command, ...(config.launch.args ?? [])].map(shellQuote).join(' ')
  return [
    `stty cols ${config.viewport.cols} rows ${config.viewport.rows}`,
    `export COLUMNS=${config.viewport.cols} LINES=${config.viewport.rows} TERM=xterm-256color`,
    envParts.length > 0 ? `export ${envParts.join(' ')}` : '',
    `exec ${command}`,
  ]
    .filter(Boolean)
    .join('; ')
}

function sanitizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function writeShot({
  artifactsDir,
  flow,
  step,
  terminal,
}: {
  artifactsDir: string
  flow: FlowConfig
  step: Extract<FlowStep, { type: 'shot' }>
  terminal: TerminalGrid
}): string {
  const flowDir = join(artifactsDir, 'shots', flow.id)
  mkdirSync(flowDir, { recursive: true })
  const name = sanitizeName(step.name)
  const svgPath = join(flowDir, `${name}.svg`)
  const txtPath = join(flowDir, `${name}.txt`)
  const label = step.label ?? `${flow.label}: ${step.name}`
  writeFileSync(svgPath, renderGridSvg(terminal.snapshot(), label), 'utf8')
  writeFileSync(txtPath, `${terminal.toText()}\n`, 'utf8')
  return svgPath
}

function tclQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\[/g, '\\[').replace(/\]/g, '\\]')}"`
}

function toHex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex')
}

function buildExpectScript(config: TuiLoopConfig, flow: FlowConfig): string {
  const lines = [
    'proc send_hex {hex} { send -- [binary format H* $hex] }',
    // drain echoes app output to stdout (for grid reconstruction) and accumulates it into
    // ::buf, which wait_for scans. Markers are sent separately and never enter ::buf.
    'set buf ""',
    'proc drain {} { expect -timeout 1 -re {(.|\\n)+} { append ::buf $expect_out(buffer); send_user $expect_out(buffer); exp_continue } timeout {} }',
    'proc wait_for {needle timeout_ms} {',
    '  set deadline [expr {[clock milliseconds] + $timeout_ms}]',
    '  while {1} {',
    '    drain',
    '    if {[string first $needle $::buf] >= 0} { return }',
    '    if {[clock milliseconds] >= $deadline} { return }',
    '    after 50',
    '  }',
    '}',
    'log_user 0',
    'set timeout -1',
    `spawn -noecho sh -lc ${tclQuote(buildShellCommand(config))}`,
    'set app_pid [exp_pid]',
    `after ${config.startupWaitMs}`,
    'drain',
  ]
  let markerIndex = 0
  for (const step of flow.steps) {
    if (step.type === 'wait') {
      lines.push(`after ${step.ms}`)
      lines.push('drain')
    } else if (step.type === 'key') {
      lines.push(`send_hex ${toHex(encodeKey(step.key))}`)
      lines.push(`after ${step.waitMs ?? 80}`)
      lines.push('drain')
    } else if (step.type === 'text') {
      lines.push(`send_hex ${toHex(step.value)}`)
      lines.push(`after ${step.waitMs ?? 80}`)
      lines.push('drain')
    } else if (step.type === 'waitForText') {
      lines.push(`wait_for ${tclQuote(step.value)} ${step.timeoutMs ?? 2000}`)
    } else if (step.type === 'shot' || step.type === 'assertText') {
      lines.push('drain')
      lines.push(`send_user "@@TUI_LOOP:${markerIndex}@@"`)
      markerIndex++
    }
  }
  lines.push(`send_hex ${toHex(encodeKey(config.shutdownKey))}`)
  lines.push('after 150')
  lines.push('drain')
  lines.push('catch {close}')
  // Force-reap the spawned app: it runs in its own session (expect's pty), so closing the
  // pty is not guaranteed to kill an app that ignores the shutdown key. The app is a session
  // leader, so its pgid equals its pid — kill the whole group (negative pid) to also reap any
  // children it spawned. kill -KILL cannot be trapped; wait -nowait avoids blocking on it.
  lines.push('catch {exec kill -KILL -$app_pid}')
  lines.push('catch {wait -nowait}')
  return lines.join('\n')
}

export type MarkedSegment = { text: string; markerIndex: number | null }

// Splits the captured stdout on @@TUI_LOOP:n@@ markers into ordered segments. Each marked
// segment carries the bytes that preceded its marker; the final segment has markerIndex null.
export function splitMarkedStream(stdout: string): MarkedSegment[] {
  const pattern = /@@TUI_LOOP:(\d+)@@/g
  const segments: MarkedSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stdout))) {
    segments.push({ text: stdout.slice(lastIndex, match.index), markerIndex: Number(match[1]) })
    lastIndex = match.index + match[0].length
  }
  segments.push({ text: stdout.slice(lastIndex), markerIndex: null })
  return segments
}

function runExpect(
  script: string,
  config: TuiLoopConfig,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('expect', ['-c', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...config.launch.env,
        COLUMNS: String(config.viewport.cols),
        LINES: String(config.viewport.rows),
        TERM: 'xterm-256color',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // New process group so the timeout backstop can reap the whole tree (expect + the
      // spawned app), not just expect — otherwise an orphaned child keeps the pipe open
      // and the 'close' event never fires.
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: { stdout: string; stderr: string; code: number | null; timedOut: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    // Hard backstop: if expect itself wedges (the in-script kill normally reaps the app first),
    // kill its process group and resolve immediately rather than waiting for 'close' — an
    // orphaned survivor can hold the stderr pipe open and that event would never fire.
    const timer = setTimeout(() => {
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL')
      } catch {
        proc.kill('SIGKILL')
      }
      finish({ stdout, stderr, code: null, timedOut: true })
    }, config.flowTimeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    proc.on('close', (code) => {
      finish({ stdout, stderr, code, timedOut: false })
    })
  })
}

async function runFlow(config: TuiLoopConfig, flow: FlowConfig): Promise<ManifestGroup> {
  const terminal = new TerminalGrid(config.viewport.cols, config.viewport.rows)
  const files: string[] = []
  const markerSteps = flow.steps.filter(
    (step) => step.type === 'shot' || step.type === 'assertText',
  )
  const result = await runExpect(buildExpectScript(config, flow), config)
  if (result.timedOut) {
    throw new Error(
      `flow "${flow.id}" timed out after ${config.flowTimeoutMs}ms (app did not exit; killed)`,
    )
  }
  for (const segment of splitMarkedStream(result.stdout)) {
    terminal.write(segment.text)
    if (segment.markerIndex === null) continue
    const step = markerSteps[segment.markerIndex]
    if (!step) continue
    if (step.type === 'shot') {
      files.push(writeShot({ artifactsDir: config.artifactsDir, flow, step, terminal }))
    } else {
      const text = terminal.toText()
      if (!text.includes(step.value)) {
        throw new Error(
          `flow "${flow.id}" did not render expected text: ${step.value}\n` +
            `Current grid:\n${text}`,
        )
      }
    }
  }

  if (files.length === 0) throw new Error(`flow "${flow.id}" did not capture any shots`)
  if (result.code && result.code !== 0 && result.stderr.trim()) {
    throw new Error(`flow "${flow.id}" exited with ${result.code}: ${result.stderr.trim()}`)
  }
  return { label: flow.label, files }
}

function writeManifest(config: TuiLoopConfig, groups: ManifestGroup[]): string {
  const manifestPath = join(config.artifactsDir, 'shots', 'manifest.json')
  mkdirSync(join(config.artifactsDir, 'shots'), { recursive: true })
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        viewport: config.viewport,
        groups,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return manifestPath
}

export async function runShots(config: TuiLoopConfig): Promise<ShotsResult> {
  const groups: ManifestGroup[] = []
  for (const flow of config.flows) {
    groups.push(await runFlow(config, flow))
  }
  const manifestPath = writeManifest(config, groups)
  return { manifestPath, groups }
}
