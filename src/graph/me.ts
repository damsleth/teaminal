// /me identity used for self/mention detection.

import { graph } from './client'

export type Me = {
  id: string
  displayName: string
  userPrincipalName: string
  mail: string | null
}

export async function getMe(signal?: AbortSignal): Promise<Me> {
  return graph<Me>({
    method: 'GET',
    path: '/me',
    query: { $select: 'id,displayName,userPrincipalName,mail' },
    signal,
  })
}
