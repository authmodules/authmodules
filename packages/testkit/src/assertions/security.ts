import type { IdentityClaim, IdentityLookup } from '@authmodules/contracts/primitives'
import { DEFAULT_REDACTED } from '../secrets/factory.ts'

export function assertRedacted(secretLike: { readonly redacted?: string }, rawSample?: unknown): void

export function assertRedacted(secretLike: { readonly redacted?: string }, rawSample?: unknown): void {
  const json = JSON.stringify(secretLike)
  if (rawSample !== undefined && json.includes(String(rawSample))) {
    throw new Error('Expected serialized value to redact raw sample')
  }
  if (!json.includes(secretLike.redacted ?? DEFAULT_REDACTED)) {
    throw new Error('Expected serialized value to include redacted marker')
  }
}

export function assertPublicView(value: unknown): void

export function assertPublicView(value: unknown): void {
  assertPublicValue(value, new Set<object>())
}

const forbiddenPublicKeys = new Set(['material', 'privateData', 'tokenHash'])
const secretDescriptorTypes = new Set(['protected-value', 'raw-secret', 'sealed-secret'])

function assertPublicValue(value: unknown, visiting: Set<object>): void {
  if (value === null || value === undefined || typeof value !== 'object' || value instanceof Date) return
  if (secretDescriptorTypes.has(String('type' in value ? value.type : ''))
    || 'reveal' in value
    || 'revealForPersistence' in value
    || 'revealCiphertextForPersistence' in value) {
    throw new Error('Public view contains a secret-bearing value')
  }
  if (visiting.has(value)) throw new Error('Public view must not be cyclic')
  visiting.add(value)
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertPublicValue(item, visiting)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenPublicKeys.has(key)) {
        throw new Error(`Public view contains forbidden field: ${key}`)
      }
      assertPublicValue(item, visiting)
    }
  } finally {
    visiting.delete(value)
  }
}

export function assertIdentityBinding(left?: IdentityLookup | IdentityClaim, right?: IdentityLookup | IdentityClaim): void

export function assertIdentityBinding(
  left?: IdentityLookup | IdentityClaim,
  right?: IdentityLookup | IdentityClaim
): void {
  if (!left || !right) {
    return
  }
  const fields = ['methodId', 'methodKind', 'subject', 'subjectKind'] as const
  for (const field of fields) {
    if (left[field] !== right[field]) {
      throw new Error(`Identity binding mismatch on ${field}`)
    }
  }
}
