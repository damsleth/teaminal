// "Empty the cache" action shared by the Settings menu.
//
// Removes a single profile's on-disk caches:
//   - the chat/teams list cache  (list[.<profile>].json)
//   - the message cache          (messages[.<profile>].json)
//   - the userId -> name index   (names[.<profile>].json)
//   - the image blob directory   (<profile>/images/)
//
// Scoped to one profile so emptying the active account's cache never
// touches another account's data. Best-effort: a missing file is counted
// as "nothing removed", not an error.

import { existsSync, unlinkSync } from 'node:fs'
import { clearImageCache, getImageCacheDir } from './imageCache'
import { flushListCache, getListCachePath } from './listCachePersistence'
import { flushMessageCache, getMessageCachePath } from './messageCachePersistence'
import { flushNameCache, getNameCachePath } from './nameCachePersistence'

type Env = Record<string, string | undefined>

export type CacheClearResult = {
  /** Cache files / directories actually removed. */
  removed: string[]
  /** The image cache directory targeted (removed or already absent). */
  imageDir: string
}

function removeFileIfPresent(path: string, removed: string[]): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path)
      removed.push(path)
    }
  } catch {
    // best-effort
  }
}

// Clear the active profile's caches. `profile` null targets the default
// (no --profile) account. Pass `env` for testability.
export function clearProfileCaches(
  profile: string | null,
  env: Env = process.env,
): CacheClearResult {
  // Land pending debounced writes first, or they'd recreate the files
  // a couple of seconds after we delete them.
  flushMessageCache()
  flushListCache()
  flushNameCache()
  const removed: string[] = []
  removeFileIfPresent(getMessageCachePath(env, profile), removed)
  removeFileIfPresent(getListCachePath(env, profile), removed)
  removeFileIfPresent(getNameCachePath(env, profile), removed)
  const imageDir = getImageCacheDir(profile)
  const hadImages = existsSync(imageDir)
  clearImageCache(profile)
  if (hadImages) removed.push(imageDir)
  return { removed, imageDir }
}
