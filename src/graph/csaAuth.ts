// Shared auth for the Teams chat-service aggregator (CSA) endpoints.
//
// CSA (`teams.microsoft.com/api/csa/{region}/...`) authenticates with a
// Bearer token for aud=chatsvcagg.teams.microsoft.com (owa-piggy's named
// `csa` audience), scope user_impersonation — NOT the skype token and NOT
// the ic3 token. Confirmed from a live teams.microsoft.com HAR + probe.

import { getToken, invalidate as invalidateOwaPiggy } from '../auth/owaPiggy'
import { recordEvent } from '../log'

export const CSA_AUDIENCE = 'csa'

export function csaHeaders(bearer: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${bearer}`,
    'x-ms-client-type': 'teaminal',
    'x-ms-client-caller': 'teaminal',
    'x-client-ui-language': 'en-us',
  }
}

export function getCsaToken(profile: string | undefined): Promise<string> {
  return getToken({ profile, audience: CSA_AUDIENCE })
}

// Run fn() with a fresh CSA Bearer; on a 401 invalidate the owa-piggy csa
// token and retry once (covers a stale cache hit / token expiry).
export async function withCsaAuth<T>(
  fn: () => Promise<T>,
  profile: string | undefined,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status: unknown }).status
        : undefined
    if (status !== 401) throw err
    recordEvent('graph', 'warn', 'csa 401, invalidating token and retrying once')
    invalidateOwaPiggy({ profile, audience: CSA_AUDIENCE })
    return await fn()
  }
}
