// Boundary tests for the dependency rules in AGENTS.md.
//
// Catches accidental layer-crossing imports before they land. The rules
// enforced here are the same ones documented under "Architecture Rules"
// in AGENTS.md - if you change one, change the other.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')
const SRC = join(REPO_ROOT, 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
  }
  return out
}

const ALL_FILES = walk(SRC)

function filesUnder(layer: string): string[] {
  return ALL_FILES.filter((f) => f.startsWith(join(SRC, layer) + '/'))
}

function importsMatch(file: string, pattern: RegExp): boolean {
  const src = readFileSync(file, 'utf8')
  for (const line of src.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('import ') && !trimmed.startsWith('export ')) continue
    if (pattern.test(line)) return true
  }
  return false
}

describe('architecture: layer boundaries', () => {
  test('src/auth does not import from graph, state, or ui', () => {
    const offenders = filesUnder('auth').filter((f) =>
      importsMatch(f, /from\s+['"][^'"]*\/(graph|state|ui)\//),
    )
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([])
  })

  test('src/graph does not import from state or ui', () => {
    const offenders = filesUnder('graph').filter((f) =>
      importsMatch(f, /from\s+['"][^'"]*\/(state|ui)\//),
    )
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([])
  })

  test('src/state does not import from ui', () => {
    const offenders = filesUnder('state').filter((f) => importsMatch(f, /from\s+['"][^'"]*\/ui\//))
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([])
  })

  test('src/ui does not call src/graph operation modules (use state/* actions instead)', () => {
    // Permitted:
    //   - `import type` (pure shape sharing, no runtime coupling)
    //   - imports from `graph/client` (error classes, active-profile config)
    // Forbidden: runtime value imports from graph/chats, graph/teams,
    // graph/me, graph/presence, graph/capabilities, graph/teamsFederation,
    // graph/teamsExternalSearch, graph/teamsPresence - those are data
    // operations that must be wrapped at the state layer.
    const forbidden = /^\s*import\s+(?!type\b)[^'"]+from\s+['"][^'"]*\/graph\/(?!client['"])/
    const offenders = filesUnder('ui').filter((f) => importsMatch(f, forbidden))
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([])
  })
})
