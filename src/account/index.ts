// Account identity. Layer-neutral: imports nothing, so auth/graph/state/ui
// can all name an account without depending on each other.
//
// An account is one owa-piggy profile. The owa-piggy default profile (no
// --profile flag) is DEFAULT_PROFILE, a symbol, so it can never collide with
// an alias spelled "default", "<default>" or "<owa-default>".

export const DEFAULT_PROFILE: unique symbol = Symbol('owa-piggy default profile')

export type AccountId = string & { readonly __brand: 'AccountId' }

export type AccountRef = {
  id: AccountId
  profile: string | typeof DEFAULT_PROFILE
  // Display only, never a key.
  label: string
}

// Versioned, injective: `v1:default` for the default profile, otherwise
// `v1:p:` + the percent-encoded alias (so `a/b`, `a_b`, `::` and Unicode
// aliases stay distinct).
export function accountIdForProfile(profile: string | typeof DEFAULT_PROFILE): AccountId {
  return (
    profile === DEFAULT_PROFILE ? 'v1:default' : `v1:p:${encodeURIComponent(profile)}`
  ) as AccountId
}

// Bridge from today's `string | null | undefined` profile (null/undefined =
// the default profile) to an AccountRef.
export function accountRef(profile: string | null | undefined): AccountRef {
  const p = profile ?? DEFAULT_PROFILE
  return {
    id: accountIdForProfile(p),
    profile: p,
    label: p === DEFAULT_PROFILE ? 'default' : p,
  }
}

// The owa-piggy `--profile` value: undefined means "no flag" (the default).
export function owaProfile(ref: AccountRef): string | undefined {
  return ref.profile === DEFAULT_PROFILE ? undefined : ref.profile
}
