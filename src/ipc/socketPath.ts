import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Per-profile socket path. macOS doesn't set XDG_RUNTIME_DIR; fall back
// to os.tmpdir() so the path is stable across processes started in the
// same login session.
export function socketPath(profile: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR || tmpdir()
  const slug = profile ?? '_default'
  return join(base, `teaminal-${slug}.sock`)
}
