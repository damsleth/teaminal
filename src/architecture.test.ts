// Boundary tests for the dependency rules in AGENTS.md.
//
// Catches accidental layer-crossing imports before they land. The rules
// enforced here are the same ones documented under "Architecture Rules"
// in AGENTS.md - if you change one, change the other.
//
// Imports are read with the TypeScript parser, not line regexes, so
// multi-line imports, `export ... from`, dynamic `import()` and directory
// imports (`'../state'`) all count, and specifiers resolve to the layer
// directory they actually point at.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

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
const BIN_FILES = walk(join(REPO_ROOT, 'bin'))
const isTest = (f: string): boolean => /\.test\.tsx?$/.test(f)

function filesUnder(layer: string): string[] {
  return ALL_FILES.filter((f) => f.startsWith(join(SRC, layer) + '/'))
}

type ImportRef = {
  specifier: string
  // `import type` / `export type` / `import('x').T`: erased at runtime.
  // `import { type X }` is NOT type-only: verbatimModuleSyntax keeps the
  // import statement, so the module still loads.
  typeOnly: boolean
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function scanImports(fileName: string, source: string): ImportRef[] {
  const out: ImportRef[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: node.importClause?.isTypeOnly === true,
      })
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      out.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly })
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push({ specifier: node.arguments[0].text, typeOnly: false })
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      out.push({ specifier: node.argument.literal.text, typeOnly: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(fileName, source))
  return out
}

// The src-relative path a relative specifier points at ('state/store',
// 'state' for a directory import), or null for a package / builtin.
function resolveToSrc(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const rel = relative(SRC, resolve(dirname(file), specifier))
  return rel.startsWith('..') ? null : rel
}

// The top-level src directory ('state', 'graph', ...) a specifier lands in.
function layerOf(file: string, specifier: string): string | null {
  const rel = resolveToSrc(file, specifier)
  return rel === null ? null : rel.split('/')[0]!
}

const importsCache = new Map<string, ImportRef[]>()
function importsOf(file: string): ImportRef[] {
  let refs = importsCache.get(file)
  if (!refs) importsCache.set(file, (refs = scanImports(file, readFileSync(file, 'utf8'))))
  return refs
}

// The files (repo-relative) with an import matching `bad`.
function offenders(
  files: string[],
  bad: (ref: ImportRef, target: string | null, file: string) => boolean,
): string[] {
  return files
    .filter((f) => importsOf(f).some((ref) => bad(ref, layerOf(f, ref.specifier), f)))
    .map((f) => relative(REPO_ROOT, f))
}

describe('architecture: import scanner', () => {
  const file = join(SRC, 'ui', 'Example.tsx')
  test('sees multi-line, re-export, dynamic, directory and type-position imports', () => {
    const src = [
      "import {\n  a,\n  b,\n} from '../auth/owaPiggy'",
      "export { c } from '../state'",
      "const m = await import('../realtime/trouter')",
      "import type { D } from '../graph/chats'",
      "export type { E } from '../graph/teams'",
      "let f: import('../graph/me').Me",
      "import { type G } from '../graph/presence'",
      "import 'node:fs'",
      "const cp = require('node:child_process')",
    ].join('\n')
    expect(scanImports(file, src)).toEqual([
      { specifier: '../auth/owaPiggy', typeOnly: false },
      { specifier: '../state', typeOnly: false },
      { specifier: '../realtime/trouter', typeOnly: false },
      { specifier: '../graph/chats', typeOnly: true },
      { specifier: '../graph/teams', typeOnly: true },
      { specifier: '../graph/me', typeOnly: true },
      { specifier: '../graph/presence', typeOnly: false },
      { specifier: 'node:fs', typeOnly: false },
      { specifier: 'node:child_process', typeOnly: false },
    ])
  })

  test('resolves specifiers to src paths', () => {
    expect(resolveToSrc(file, '../state')).toBe('state')
    expect(resolveToSrc(file, './keybinds/listKeys')).toBe('ui/keybinds/listKeys')
    expect(resolveToSrc(file, '../../package.json')).toBeNull()
    expect(resolveToSrc(file, 'ink')).toBeNull()
  })
})

describe('architecture: layer boundaries', () => {
  test('src/account imports nothing from the rest of src', () => {
    const out = offenders(
      filesUnder('account'),
      (_ref, target) => target !== null && target !== 'account',
    )
    expect(out).toEqual([])
  })

  test('src/settings imports nothing from the rest of src', () => {
    const out = offenders(
      filesUnder('settings'),
      (_ref, target) => target !== null && target !== 'settings',
    )
    expect(out).toEqual([])
  })

  test('src/config reads settings from src/settings, not from state or the layers above', () => {
    const out = offenders(filesUnder('config'), (_ref, target) =>
      ['state', 'ui', 'graph', 'auth', 'realtime'].includes(target ?? ''),
    )
    expect(out).toEqual([])
  })

  test('src/auth does not import from graph, state, or ui', () => {
    const out = offenders(filesUnder('auth'), (_ref, target) =>
      ['graph', 'state', 'ui'].includes(target ?? ''),
    )
    expect(out).toEqual([])
  })

  test('src/graph does not import from state or ui', () => {
    const out = offenders(filesUnder('graph'), (_ref, target) =>
      ['state', 'ui'].includes(target ?? ''),
    )
    expect(out).toEqual([])
  })

  test('src/state does not import from ui', () => {
    const out = offenders(filesUnder('state'), (_ref, target) => target === 'ui')
    expect(out).toEqual([])
  })

  test('src/ui reaches src/auth and src/realtime only through state (type imports allowed)', () => {
    const out = offenders(
      filesUnder('ui').filter((f) => !isTest(f)),
      (ref, target) => !ref.typeOnly && (target === 'auth' || target === 'realtime'),
    )
    expect(out).toEqual([])
  })

  test('src/ui does not call src/graph operation modules (use state/* actions instead)', () => {
    // Permitted:
    //   - `import type` (pure shape sharing, no runtime coupling)
    //   - imports from `graph/client` (error classes, GraphClient type)
    // Forbidden: runtime value imports from graph/chats, graph/teams,
    // graph/me, graph/presence, graph/capabilities, graph/teamsFederation,
    // graph/teamsExternalSearch, graph/teamsPresence - those are data
    // operations that must be wrapped at the state layer.
    const out = offenders(
      filesUnder('ui'),
      (ref, target, f) =>
        !ref.typeOnly && target === 'graph' && resolveToSrc(f, ref.specifier) !== 'graph/client',
    )
    expect(out).toEqual([])
  })
})

// Rule 5, first half. Every module that starts a process, as it stands.
// Adding one is a deliberate change: put it here and in AGENTS.md rule 5.
const SPAWNERS = [
  'src/auth/owaPiggy.ts', // the owa-piggy token broker
  'src/notify/notify.ts', // terminal-notifier / osascript banners
  'src/state/systemAppearance.ts', // `defaults read` for the OS appearance
  'src/ui/emojiPicker.ts', // the macOS Character Viewer
  'src/ui/openExternal.ts', // open / xdg-open for links
  'src/ui/openImageFile.ts', // open / xdg-open for an image file
  'src/ui/openInEditor.ts', // $VISUAL / $EDITOR on the config file
]

function spawnsProcess(file: string): boolean {
  // child_process in any form; any value import of 'bun' ({ spawn, $ }).
  if (importsOf(file).some((r) => /^((node:)?child_process|bun)$/.test(r.specifier) && !r.typeOnly))
    return true
  let found = false
  const visit = (node: ts.Node): void => {
    // Bun.spawn / Bun.spawnSync / Bun.$
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Bun' &&
      ['spawn', 'spawnSync', '$'].includes(node.name.text)
    )
      found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(parse(file, readFileSync(file, 'utf8')))
  return found
}

describe('architecture: subprocesses', () => {
  test('only the listed modules start processes', () => {
    const spawning = [...ALL_FILES, ...BIN_FILES]
      .filter((f) => !isTest(f) && spawnsProcess(f))
      .map((f) => relative(REPO_ROOT, f))
    expect(spawning.sort()).toEqual([...SPAWNERS].sort())
  })
})

// Rule 5, second half. Graph requests get their bearer from
// src/graph/client.ts. The Teams-service clients below still build their own
// Authorization header (other audiences, skype / asyncgw session tokens);
// this list only stops new ones from appearing unnoticed. Folding them into
// one shared authed fetch is open work (code review #7).
const AUTH_HEADER_SITES = [
  'src/graph/client.ts',
  'src/graph/csaAuth.ts',
  'src/graph/teamsAsyncGw.ts',
  'src/graph/teamsExternalSearch.ts',
  'src/graph/teamsFederation.ts',
  'src/graph/teamsPresence.ts',
  'src/realtime/trouter.ts',
]

const isAuthorization = (node: ts.Node): boolean =>
  (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
  node.text.toLowerCase() === 'authorization'

function setsAuthorizationHeader(source: string, fileName = 'x.ts'): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    // { Authorization: ... } / { 'authorization': ... }
    if (ts.isPropertyAssignment(node) && isAuthorization(node.name)) found = true
    // headers['Authorization'] = ...
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      isAuthorization(node.left.argumentExpression)
    )
      found = true
    // headers.set('Authorization', ...) / headers.append(...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['set', 'append'].includes(node.expression.name.text) &&
      node.arguments[0] &&
      isAuthorization(node.arguments[0])
    )
      found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(parse(fileName, source))
  return found
}

describe('architecture: Authorization headers', () => {
  test('the detector sees literals and set() calls, not comments or comparisons', () => {
    expect(setsAuthorizationHeader("fetch(u, { headers: { Authorization: 'Bearer x' } })")).toBe(
      true,
    )
    expect(setsAuthorizationHeader("h.set('authorization', t)")).toBe(true)
    expect(setsAuthorizationHeader("h['Authorization'] = t")).toBe(true)
    expect(setsAuthorizationHeader("// Authorization: Bearer\nif (k === 'authorization') {}")).toBe(
      false,
    )
  })

  test('only the listed modules build an Authorization header', () => {
    const sites = [...ALL_FILES, ...BIN_FILES]
      .filter((f) => !isTest(f) && setsAuthorizationHeader(readFileSync(f, 'utf8'), f))
      .map((f) => relative(REPO_ROOT, f))
    expect(sites.sort()).toEqual([...AUTH_HEADER_SITES].sort())
  })
})
