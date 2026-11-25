// Auth actions for the UI. The UI reaches owa-piggy only through here
// (layering: ui -> state -> auth), and every call names its account.

import { owaProfile } from '../account'
import { decodeJwtClaims, getToken } from '../auth/owaPiggy'
import type { GraphClient } from '../graph/client'

export { listProfilesFromStatus, reseed, type OwaPiggyProfileStatus } from '../auth/owaPiggy'

/** Claims of the bound account's access token (never the token itself). */
export async function accessTokenClaims(client: GraphClient): Promise<Record<string, unknown>> {
  return decodeJwtClaims(await getToken({ profile: owaProfile(client.ctx.account) }))
}
