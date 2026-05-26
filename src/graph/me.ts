// /me identity used for self/mention detection.

import { decodeJwtClaims, getToken } from '../auth/owaPiggy'
import { recordEvent } from '../log'
import { getActiveProfile, graph, GraphError } from './client'

export type Me = {
  id: string
  displayName: string
  userPrincipalName: string
  mail: string | null
}

export async function getMe(signal?: AbortSignal): Promise<Me> {
  try {
    return await graph<Me>({
      method: 'GET',
      path: '/me',
      query: { $select: 'id,displayName,userPrincipalName,mail' },
      signal,
    })
  } catch (err) {
    if (err instanceof GraphError && err.status === 401) {
      // graph /me is Conditional-Access gated in some tenants. The access
      // token itself carries everything we need (oid / name / upn), so
      // derive identity from its claims rather than failing bootstrap.
      const fromToken = await meFromToken()
      if (fromToken) {
        recordEvent(
          'graph',
          'warn',
          'graph /me 401 (likely Conditional Access) — using token claims',
        )
        return fromToken
      }
    }
    throw err
  }
}

async function meFromToken(): Promise<Me | null> {
  try {
    const token = await getToken({ profile: getActiveProfile() })
    const claims = decodeJwtClaims(token)
    const id = typeof claims.oid === 'string' ? claims.oid : undefined
    if (!id) return null
    const upn =
      (typeof claims.upn === 'string' && claims.upn) ||
      (typeof claims.unique_name === 'string' && claims.unique_name) ||
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      ''
    const displayName =
      (typeof claims.name === 'string' && claims.name) ||
      [claims.given_name, claims.family_name]
        .filter((s) => typeof s === 'string')
        .join(' ')
        .trim() ||
      upn ||
      id
    return {
      id,
      displayName,
      userPrincipalName: upn,
      mail: typeof claims.email === 'string' ? claims.email : upn || null,
    }
  } catch {
    return null
  }
}
