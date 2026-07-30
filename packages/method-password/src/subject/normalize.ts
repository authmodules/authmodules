import type { IdentityClaim, IdentityLookup } from '@authmodules/contracts/primitives'

export function normalizeSubject(subject: string, subjectKind: string): string {
  const trimmed = subject.trim()
  return subjectKind === 'email' ? trimmed.toLowerCase() : trimmed
}

export function makeIdentityClaim(lookup: IdentityLookup): IdentityClaim {
  return { ...lookup }
}
