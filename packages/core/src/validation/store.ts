import type {
  AccountRecord,
  ChallengeRecord,
  CredentialRecord,
  IdentityRecord,
  RecordFailedAttemptResult,
  SessionRecord
} from '@authmodules/contracts/store'
import type { ConsumePendingResult } from '@authmodules/contracts/store'
import { isNonEmptyString, isPublicData, isValidDate } from './input.ts'
import { isIdentityLookup, isMethodMaterial } from './method-data.ts'
import { isStableMethodId } from './method.ts'
import { isProtectedValue } from './token.ts'

const accountKeys = new Set(['accountId', 'createdAt', 'publicData', 'status', 'tenantId', 'updatedAt'])
const bindingKeys = new Set(['account', 'session', 'startedByActor'])
const challengeKeys = new Set([
  'attempts',
  'binding',
  'challengeId',
  'consumedAt',
  'createdAt',
  'expiresAt',
  'lookup',
  'material',
  'maxAttempts',
  'methodId',
  'methodKind',
  'status',
  'tenantId',
  'updatedAt',
  'version'
])
const credentialKeys = new Set([
  'accountId',
  'createdAt',
  'credentialId',
  'identityId',
  'material',
  'methodId',
  'methodKind',
  'status',
  'tenantId',
  'updatedAt',
  'version'
])
const identityKeys = new Set([
  'accountId',
  'createdAt',
  'display',
  'identityId',
  'methodId',
  'methodKind',
  'subject',
  'subjectKind',
  'tenantId',
  'updatedAt',
  'verifiedAt'
])
const sessionKeys = new Set([
  'accountId',
  'createdAt',
  'expiresAt',
  'issuedAt',
  'revokedAt',
  'sessionId',
  'status',
  'tenantId',
  'tokenHash',
  'updatedAt'
])
const challengeAttemptKeys = new Set(['challenge', 'status'])
const challengeVersionConflictKeys = new Set(['status'])
const consumePendingResults = new Set<unknown>([
  'already-consumed',
  'attempts-exceeded',
  'consumed',
  'expired',
  'version-conflict'
])

export function isAccountRecord(value: unknown): value is AccountRecord {
  return isRecord(value)
    && hasOnlyKeys(value, accountKeys)
    && isNonEmptyString(value.tenantId)
    && isNonEmptyString(value.accountId)
    && (value.status === 'active' || value.status === 'disabled' || value.status === 'deleted')
    && isDateOrder(value.createdAt, value.updatedAt)
    && isPublicData(value.publicData)
}

export function isIdentityRecord(value: unknown): value is IdentityRecord {
  return isRecord(value)
    && hasOnlyKeys(value, identityKeys)
    && isNonEmptyString(value.tenantId)
    && isNonEmptyString(value.identityId)
    && isNonEmptyString(value.accountId)
    && isStableMethodId(value.methodId)
    && isNonEmptyString(value.methodKind)
    && isNonEmptyString(value.subject)
    && isNonEmptyString(value.subjectKind)
    && (value.display === undefined
      || (typeof value.display === 'string'
        && value.display.length <= 512
        && !/[\u0000-\u001f\u007f]/.test(value.display)))
    && (value.verifiedAt === undefined || isValidDate(value.verifiedAt))
    && isDateOrder(value.createdAt, value.updatedAt)
}

export function isCredentialRecord(value: unknown): value is CredentialRecord {
  return isRecord(value)
    && hasOnlyKeys(value, credentialKeys)
    && isNonEmptyString(value.tenantId)
    && isNonEmptyString(value.credentialId)
    && isNonEmptyString(value.accountId)
    && isNonEmptyString(value.identityId)
    && isStableMethodId(value.methodId)
    && isNonEmptyString(value.methodKind)
    && (value.status === 'active' || value.status === 'disabled')
    && isMethodMaterial(value.material)
    && value.material !== undefined
    && isPositiveInteger(value.version)
    && isDateOrder(value.createdAt, value.updatedAt)
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  return isRecord(value)
    && hasOnlyKeys(value, sessionKeys)
    && isNonEmptyString(value.tenantId)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.accountId)
    && isProtectedValue(value.tokenHash)
    && (value.status === 'active' || value.status === 'revoked' || value.status === 'expired')
    && isValidDate(value.issuedAt)
    && isValidDate(value.expiresAt)
    && value.issuedAt <= value.expiresAt
    && (value.revokedAt === undefined || isValidDate(value.revokedAt))
    && isDateOrder(value.createdAt, value.updatedAt)
}

export function isChallengeRecord(value: unknown): value is ChallengeRecord {
  return isRecord(value)
    && hasOnlyKeys(value, challengeKeys)
    && isNonEmptyString(value.tenantId)
    && isNonEmptyString(value.challengeId)
    && isStableMethodId(value.methodId)
    && isNonEmptyString(value.methodKind)
    && isIdentityLookup(value.lookup)
    && (value.status === 'pending'
      || value.status === 'consumed'
      || value.status === 'expired'
      || value.status === 'failed')
    && isMethodMaterial(value.material)
    && value.material !== undefined
    && isChallengeBinding(value.binding)
    && isNonNegativeInteger(value.attempts)
    && isPositiveInteger(value.maxAttempts)
    && value.attempts <= value.maxAttempts
    && isPositiveInteger(value.version)
    && isValidDate(value.expiresAt)
    && (value.consumedAt === undefined || isValidDate(value.consumedAt))
    && isDateOrder(value.createdAt, value.updatedAt)
}

export function accountRecordFingerprint(value: unknown): string | undefined {
  return isAccountRecord(value) ? fingerprint(value) : undefined
}

export function identityRecordFingerprint(value: unknown): string | undefined {
  return isIdentityRecord(value) ? fingerprint(value) : undefined
}

export function credentialRecordFingerprint(value: unknown): string | undefined {
  return isCredentialRecord(value) ? fingerprint(value) : undefined
}

export function challengeRecordFingerprint(value: unknown): string | undefined {
  return isChallengeRecord(value) ? fingerprint(value) : undefined
}

export function isConsumePendingResult(value: unknown): value is ConsumePendingResult {
  return consumePendingResults.has(value)
}

export function isRecordFailedAttemptResult(value: unknown): value is RecordFailedAttemptResult {
  if (!isRecord(value)) return false
  if (value.status === 'version-conflict') {
    return hasOnlyKeys(value, challengeVersionConflictKeys)
  }
  return (value.status === 'recorded'
      || value.status === 'attempts-exceeded'
      || value.status === 'expired')
    && hasOnlyKeys(value, challengeAttemptKeys)
    && isChallengeRecord(value.challenge)
}

export function isRecordFailedAttemptTransition(
  previous: ChallengeRecord,
  value: unknown,
  now: Date
): value is RecordFailedAttemptResult {
  if (!isRecordFailedAttemptResult(value)) return false
  if (value.status === 'version-conflict') return true
  const current = value.challenge
  if (!sameChallengePayload(previous, current)
    || current.updatedAt.getTime() !== now.getTime()) return false
  if (value.status === 'recorded') {
    return current.status === 'pending'
      && current.attempts === previous.attempts + 1
      && current.attempts < current.maxAttempts
      && current.version === previous.version + 1
  }
  if (value.status === 'attempts-exceeded') {
    return current.status === 'failed'
      && current.attempts === previous.attempts + 1
      && current.attempts === current.maxAttempts
      && current.version === previous.version + 1
  }
  return current.status === 'expired'
    && previous.expiresAt <= now
    && current.attempts === previous.attempts
    && current.version === previous.version + 1
}

function sameChallengePayload(left: ChallengeRecord, right: ChallengeRecord): boolean {
  try {
    return left.tenantId === right.tenantId
      && left.challengeId === right.challengeId
      && left.methodId === right.methodId
      && left.methodKind === right.methodKind
      && left.maxAttempts === right.maxAttempts
      && left.expiresAt.getTime() === right.expiresAt.getTime()
      && left.createdAt.getTime() === right.createdAt.getTime()
      && left.consumedAt?.getTime() === right.consumedAt?.getTime()
      && fingerprint(left.lookup) === fingerprint(right.lookup)
      && fingerprint(left.material) === fingerprint(right.material)
      && fingerprint(left.binding) === fingerprint(right.binding)
  } catch {
    return false
  }
}

function isChallengeBinding(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, bindingKeys)
    && isAccountMode(value.account)
    && isSessionRequest(value.session)
    && isActor(value.startedByActor)
}

function isAccountMode(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).length === 1
    && (value.mode === 'create-new-account'
      || value.mode === 'require-existing-identity'
      || value.mode === 'create-account-if-identity-missing'
      || value.mode === 'link-to-actor-account')
}

function isSessionRequest(value: unknown): boolean {
  return value === undefined || (isRecord(value)
    && Object.keys(value).every((key) => key === 'ttlSeconds')
    && (value.ttlSeconds === undefined || isPositiveInteger(value.ttlSeconds)))
}

function isActor(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value.type === 'anonymous') return Object.keys(value).length === 1
  if (value.type === 'account') {
    return Object.keys(value).every((key) => key === 'accountId' || key === 'type')
      && Object.keys(value).length === 2
      && isNonEmptyString(value.accountId)
  }
  return value.type === 'system'
    && Object.keys(value).every((key) => key === 'name' || key === 'type')
    && Object.keys(value).length === 2
    && isNonEmptyString(value.name)
}

function isDateOrder(createdAt: unknown, updatedAt: unknown): boolean {
  return isValidDate(createdAt) && isValidDate(updatedAt) && createdAt <= updatedAt
}

function fingerprint(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return ['undefined']
  if (value instanceof Date) return ['date', value.getTime()]
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('type' in value && value.type === 'protected-value' && 'revealForPersistence' in value
      && typeof value.revealForPersistence === 'function') {
      return [
        'protected-value',
        record.scheme,
        record.keyId ?? '',
        canonicalValue(record.createdAt),
        value.revealForPersistence()
      ]
    }
    if ('type' in value && value.type === 'sealed-secret' && 'revealCiphertextForPersistence' in value
      && typeof value.revealCiphertextForPersistence === 'function') {
      return [
        'sealed-secret',
        record.algorithm,
        record.keyId,
        canonicalValue(record.expiresAt),
        value.revealCiphertextForPersistence()
      ]
    }
    return Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)])
  }
  return value
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
