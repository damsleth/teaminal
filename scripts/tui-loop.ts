#!/usr/bin/env bun

import { resolve } from 'node:path'
import { loadTuiLoopConfig } from './tui-loop/config'
import { runShots } from './tui-loop/runner'

const HELP = `tui-loop

USAGE
  bun run scripts/tui-loop.ts <command> [--config tui.config.mjs]

COMMANDS
  flows    list configured flows
  shots    run flows and write .tui-loop/shots artifacts
`

function parseArgs(argv: string[]): { command: string; configPath: string } {
  let command = argv[0] ?? 'help'
  let configPath = 'tui.config.mjs'
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') {
      const next = argv[i + 1]
      if (!next || next.startsWith('-')) throw new Error('--config requires a path')
      configPath = next
      i++
    } else if (arg === '--help' || arg === '-h') {
      command = 'help'
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return { command, configPath: resolve(configPath) }
}

async function main(): Promise<void> {
  const { command, configPath } = parseArgs(Bun.argv.slice(2))
  if (command === 'help') {
    process.stdout.write(HELP)
    return
  }

  const config = await loadTuiLoopConfig(configPath)
  if (command === 'flows') {
    for (const flow of config.flows) {
      process.stdout.write(`${flow.id}\t${flow.label}\n`)
    }
    return
  }

  if (command === 'shots') {
    const result = await runShots(config)
    const shotCount = result.groups.reduce((total, group) => total + group.files.length, 0)
    process.stdout.write(
      `Captured ${shotCount} shots across ${result.groups.length} flows.\nManifest: ${result.manifestPath}\n`,
    )
    return
  }

  throw new Error(`unknown command: ${command}`)
}

try {
  await main()
} catch (err) {
  process.stderr.write(`tui-loop: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
