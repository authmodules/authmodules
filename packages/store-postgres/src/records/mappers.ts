import type { ChallengeMaterial, CredentialMaterial } from '@authmodules/contracts/material'
import type { SecretFactory } from '@authmodules/contracts/security'
import type {
  AccountRecord,
  ChallengeRecord,
  CredentialRecord,
  IdentityRecord,
  SessionRecord
} from '@authmodules/contracts/store'
import { reviveSecrets } from '../serialization/secrets.ts'
import { date } from '../shared/date.ts'
import { isSafeStoredText } from '../shared/validation.ts'
import {
  isChallengeBinding,
  isIdentityLookup,
  isMethodMaterial,
  isPublicData,
  isRuntimeProtectedValue
} from './validation.ts'

type SecretReviver = Pick<SecretFactory, 'protectedValue' | 'sealedValue'>

export function accountFromRow(value: unknown): AccountRecord {
  const row = record(value)
  const publicData = optionalValue(row.public_data)
  if (!isPublicData(publicData)) throw new TypeError('PostgreSQL returned invalid account public data')
  return {
    tenantId: text(row.tenant_id),
    accountId: text(row.account_id),
    status: oneOf(row.status, ['active', 'disabled', 'deleted']),
    publicData,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at)
  }
}

export function identityFromRow(value: unknown): IdentityRecord {
  const row = record(value)
  return {
    tenantId: text(row.tenant_id),
    identityId: text(row.identity_id),
    accountId: text(row.account_id),
    methodId: text(row.method_id),
    methodKind: text(row.method_kind),
    subject: text(row.subject),
    subjectKind: text(row.subject_kind),
    display: optionalText(row.display),
    verifiedAt: optionalDate(row.verified_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at)
  }
}

export function credentialFromRow(value: unknown, secretFactory?: SecretReviver): CredentialRecord {
  const row = record(value)
  const material = reviveSecrets(row.material, secretFactory)
  if (!isMethodMaterial(material)) throw new TypeError('PostgreSQL returned invalid credential material')
  return {
    tenantId: text(row.tenant_id),
    credentialId: text(row.credential_id),
    accountId: text(row.account_id),
    identityId: text(row.identity_id),
    methodId: text(row.method_id),
    methodKind: text(row.method_kind),
    status: oneOf(row.status, ['active', 'disabled']),
    material: material as CredentialMaterial,
    version: positiveInteger(row.version),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at)
  }
}

export function sessionFromRow(value: unknown, secretFactory?: SecretReviver): SessionRecord {
  const row = record(value)
  const tokenHash = reviveSecrets(row.token_hash, secretFactory)
  if (!isRuntimeProtectedValue(tokenHash)) throw new TypeError('PostgreSQL returned invalid session token hash')
  return {
    tenantId: text(row.tenant_id),
    sessionId: text(row.session_id),
    accountId: text(row.account_id),
    tokenHash,
    status: oneOf(row.status, ['active', 'revoked', 'expired']),
    issuedAt: date(row.issued_at),
    expiresAt: date(row.expires_at),
    revokedAt: optionalDate(row.revoked_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at)
  }
}

export function challengeFromRow(value: unknown, secretFactory?: SecretReviver): ChallengeRecord {
  const row = record(value)
  const material = reviveSecrets(row.material, secretFactory)
  const lookup = optionalValue(row.lookup)
  const binding = row.binding
  if (!isMethodMaterial(material)) throw new TypeError('PostgreSQL returned invalid challenge material')
  if (!isIdentityLookup(lookup)) throw new TypeError('PostgreSQL returned invalid challenge lookup')
  if (!isChallengeBinding(binding)) throw new TypeError('PostgreSQL returned invalid challenge binding')
  return {
    tenantId: text(row.tenant_id),
    challengeId: text(row.challenge_id),
    methodId: text(row.method_id),
    methodKind: text(row.method_kind),
    lookup,
    status: oneOf(row.status, ['pending', 'consumed', 'expired', 'failed']),
    material: material as ChallengeMaterial,
    binding,
    attempts: nonNegativeInteger(row.attempts),
    maxAttempts: positiveInteger(row.max_attempts),
    version: positiveInteger(row.version),
    expiresAt: date(row.expires_at),
    consumedAt: optionalDate(row.consumed_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at)
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PostgreSQL returned an invalid row')
  }
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (!isSafeStoredText(value, 2048, true)) throw new TypeError('PostgreSQL returned invalid text')
  return value
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value)
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('PostgreSQL returned invalid integer')
  return value
}

function nonNegativeInteger(value: unknown): number {
  const parsed = integer(value)
  if (parsed < 0) throw new TypeError('PostgreSQL returned invalid non-negative integer')
  return parsed
}

function positiveInteger(value: unknown): number {
  const parsed = integer(value)
  if (parsed <= 0) throw new TypeError('PostgreSQL returned invalid positive integer')
  return parsed
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError('PostgreSQL returned invalid enum value')
  return value as T[number]
}

function optionalDate(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : date(value)
}

function optionalValue(value: unknown): unknown {
  return value === null ? undefined : value
}
