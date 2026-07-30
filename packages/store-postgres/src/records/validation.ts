import type { ChallengeMaterial, CredentialMaterial } from '@authmodules/contracts/material'
import type { ChallengeBinding, IdentityLookup, PublicData } from '@authmodules/contracts/primitives'
import type { ProtectedValue, SealedSecretValue } from '@authmodules/contracts/security'
import type {
  AccountRecord,
  ChallengeRecord,
  CredentialRecord,
  IdentityRecord,
  SessionRecord
} from '@authmodules/contracts/store'
import { isSafeStoredText, isValidDate } from '../shared/validation.ts'

const secretDescriptorTypes = new Set<unknown>(['raw-secret', 'protected-value', 'sealed-secret'])

const actorAccountKeys = new Set(['accountId', 'type'])
const actorAnonymousKeys = new Set(['type'])
const actorSystemKeys = new Set(['name', 'type'])
const accountKeys = new Set(['accountId', 'createdAt', 'publicData', 'status', 'tenantId', 'updatedAt'])
const bindingKeys = new Set(['account', 'session', 'startedByActor'])
const identityLookupKeys = new Set(['display', 'methodId', 'methodKind', 'subject', 'subjectKind'])
const materialKeys = new Set(['privateData', 'publicData', 'schemaVersion'])
const modeKeys = new Set(['mode'])
const sessionKeys = new Set(['ttlSeconds'])
const identityRecordKeys = new Set([
  'accountId', 'createdAt', 'display', 'identityId', 'methodId', 'methodKind',
  'subject', 'subjectKind', 'tenantId', 'updatedAt', 'verifiedAt'
])
const credentialRecordKeys = new Set([
  'accountId', 'createdAt', 'credentialId', 'identityId', 'material', 'methodId',
  'methodKind', 'status', 'tenantId', 'updatedAt', 'version'
])
const sessionRecordKeys = new Set([
  'accountId', 'createdAt', 'expiresAt', 'issuedAt', 'revokedAt', 'sessionId',
  'status', 'tenantId', 'tokenHash', 'updatedAt'
])
const challengeRecordKeys = new Set([
  'attempts', 'binding', 'challengeId', 'consumedAt', 'createdAt', 'expiresAt',
  'lookup', 'material', 'maxAttempts', 'methodId', 'methodKind', 'status',
  'tenantId', 'updatedAt', 'version'
])

export function isAccountRecord(value: unknown): value is AccountRecord {
  return isRecord(value)
    && hasOnlyKeys(value, accountKeys)
    && isIdentifier(value.tenantId)
    && isIdentifier(value.accountId)
    && (value.status === 'active' || value.status === 'disabled' || value.status === 'deleted')
    && isPublicData(value.publicData)
    && isValidDate(value.createdAt)
    && isValidDate(value.updatedAt)
}

export function isIdentityRecord(value: unknown): value is IdentityRecord {
  return isRecord(value)
    && hasOnlyKeys(value, identityRecordKeys)
    && isIdentifier(value.tenantId)
    && isIdentifier(value.identityId)
    && isIdentifier(value.accountId)
    && isIdentifier(value.methodId)
    && isIdentifier(value.methodKind)
    && isSafeStoredText(value.subject, 2048, true)
    && isIdentifier(value.subjectKind)
    && (value.display === undefined || isSafeStoredText(value.display, 2048, false))
    && (value.verifiedAt === undefined || isValidDate(value.verifiedAt))
    && isValidDate(value.createdAt)
    && isValidDate(value.updatedAt)
}

export function isCredentialRecord(value: unknown): value is CredentialRecord {
  return isRecord(value)
    && hasOnlyKeys(value, credentialRecordKeys)
    && isIdentifier(value.tenantId)
    && isIdentifier(value.credentialId)
    && isIdentifier(value.accountId)
    && isIdentifier(value.identityId)
    && isIdentifier(value.methodId)
    && isIdentifier(value.methodKind)
    && (value.status === 'active' || value.status === 'disabled')
    && isMethodMaterial(value.material)
    && isPositiveInteger(value.version)
    && isValidDate(value.createdAt)
    && isValidDate(value.updatedAt)
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  return isRecord(value)
    && hasOnlyKeys(value, sessionRecordKeys)
    && isIdentifier(value.tenantId)
    && isIdentifier(value.sessionId)
    && isIdentifier(value.accountId)
    && isRuntimeProtectedValue(value.tokenHash)
    && (value.status === 'active' || value.status === 'revoked' || value.status === 'expired')
    && isValidDate(value.issuedAt)
    && isValidDate(value.expiresAt)
    && value.expiresAt > value.issuedAt
    && (value.revokedAt === undefined || isValidDate(value.revokedAt))
    && ((value.status === 'revoked') === (value.revokedAt !== undefined))
    && isValidDate(value.createdAt)
    && isValidDate(value.updatedAt)
}

export function isChallengeRecord(value: unknown): value is ChallengeRecord {
  return isRecord(value)
    && hasOnlyKeys(value, challengeRecordKeys)
    && isIdentifier(value.tenantId)
    && isIdentifier(value.challengeId)
    && isIdentifier(value.methodId)
    && isIdentifier(value.methodKind)
    && isIdentityLookup(value.lookup)
    && (value.status === 'pending'
      || value.status === 'consumed'
      || value.status === 'expired'
      || value.status === 'failed')
    && isMethodMaterial(value.material)
    && isChallengeBinding(value.binding)
    && isNonNegativeInteger(value.attempts)
    && isPositiveInteger(value.maxAttempts)
    && value.attempts <= value.maxAttempts
    && isPositiveInteger(value.version)
    && isValidDate(value.expiresAt)
    && (value.consumedAt === undefined || isValidDate(value.consumedAt))
    && ((value.status === 'consumed') === (value.consumedAt !== undefined))
    && isValidDate(value.createdAt)
    && isValidDate(value.updatedAt)
}

export function isPublicData(value: unknown): value is PublicData | undefined {
  return value === undefined || isJsonObject(value)
}

export function isMethodMaterial(
  value: unknown
): value is CredentialMaterial | ChallengeMaterial {
  return isRecord(value)
    && hasOnlyKeys(value, materialKeys)
    && isSafeStoredText(value.schemaVersion, 512, true)
    && isPublicData(value.publicData)
    && isPrivateData(value.privateData)
}

export function isIdentityLookup(value: unknown): value is IdentityLookup | undefined {
  return value === undefined || (isRecord(value)
    && hasOnlyKeys(value, identityLookupKeys)
    && isSafeStoredText(value.methodId, 512, true)
    && isSafeStoredText(value.methodKind, 512, true)
    && isSafeStoredText(value.subject, 2048, true)
    && isSafeStoredText(value.subjectKind, 512, true)
    && (value.display === undefined || isSafeStoredText(value.display, 2048, false)))
}

export function isChallengeBinding(value: unknown): value is ChallengeBinding {
  return isRecord(value)
    && hasOnlyKeys(value, bindingKeys)
    && isAccountMode(value.account)
    && isSessionRequest(value.session)
    && isActor(value.startedByActor)
}

export function isRuntimeProtectedValue(value: unknown): value is ProtectedValue {
  return isRecord(value)
    && value.type === 'protected-value'
    && isSafeStoredText(value.scheme, 256, true)
    && typeof value.redacted === 'string'
    && (value.keyId === undefined || isSafeStoredText(value.keyId, 512, false))
    && (value.createdAt === undefined || isValidDate(value.createdAt))
    && typeof value.revealForPersistence === 'function'
    && typeof value.toJSON === 'function'
    && !hasFunction(value, 'reveal')
    && !hasFunction(value, 'revealCiphertextForPersistence')
}

function isPrivateData(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || Object.keys(value).length > 1000) return false
  const state: JsonState = { visiting: new Set(), nodes: 0, characters: 0 }
  return Object.entries(value).every(([key, item]) => isSafeStoredText(key, 512, true)
    && (isRuntimeProtectedValue(item) || isRuntimeSealedValue(item) || isJsonValue(item, 0, state)))
}

function isRuntimeSealedValue(value: unknown): value is SealedSecretValue {
  return isRecord(value)
    && value.type === 'sealed-secret'
    && isSafeStoredText(value.algorithm, 256, true)
    && isSafeStoredText(value.keyId, 512, true)
    && typeof value.redacted === 'string'
    && (value.expiresAt === undefined || isValidDate(value.expiresAt))
    && typeof value.revealCiphertextForPersistence === 'function'
    && typeof value.toJSON === 'function'
    && !hasFunction(value, 'reveal')
    && !hasFunction(value, 'revealForPersistence')
}

function isAccountMode(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, modeKeys)
    && (value.mode === 'create-new-account'
      || value.mode === 'require-existing-identity'
      || value.mode === 'create-account-if-identity-missing'
      || value.mode === 'link-to-actor-account')
}

function isSessionRequest(value: unknown): boolean {
  return value === undefined || (isRecord(value)
    && hasOnlyKeys(value, sessionKeys)
    && (value.ttlSeconds === undefined
      || (Number.isSafeInteger(value.ttlSeconds) && Number(value.ttlSeconds) > 0)))
}

function isActor(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value.type === 'anonymous') return hasOnlyKeys(value, actorAnonymousKeys)
  if (value.type === 'account') {
    return hasOnlyKeys(value, actorAccountKeys) && isSafeStoredText(value.accountId, 512, true)
  }
  if (value.type === 'system') {
    return hasOnlyKeys(value, actorSystemKeys) && isSafeStoredText(value.name, 512, true)
  }
  return false
}

function isJsonObject(value: unknown): boolean {
  return isPlainObject(value) && isJsonValue(value, 0, { visiting: new Set(), nodes: 0, characters: 0 })
}

function isJsonValue(value: unknown, depth: number, state: JsonState): boolean {
  state.nodes += 1
  if (state.nodes > 1000) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return consumeText(value, 65536, state)
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || value instanceof Date || depth >= 16 || state.visiting.has(value)) return false
  if (isSecretDescriptor(value)) return false
  if (hasFunction(value, 'reveal')
    || hasFunction(value, 'revealForPersistence')
    || hasFunction(value, 'revealCiphertextForPersistence')) return false
  state.visiting.add(value)
  const valid = Array.isArray(value)
    ? isDenseJsonArray(value) && value.every((item) => isJsonValue(item, depth + 1, state))
    : isPlainObject(value) && Object.entries(value).every(([key, item]) => consumeText(key, 512, state, true)
      && isJsonValue(item, depth + 1, state))
  state.visiting.delete(value)
  return valid
}

function consumeText(
  value: unknown,
  maxLength: number,
  state: JsonState,
  requireNonEmpty = false
): value is string {
  if (!isSafeStoredText(value, maxLength, requireNonEmpty)) return false
  state.characters += value.length
  return state.characters <= 1_000_000
}

function isDenseJsonArray(value: unknown[]): boolean {
  const keys = Object.keys(value)
  return keys.length === value.length && keys.every((key, index) => key === String(index))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is string {
  return isSafeStoredText(value, 512, true)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}

function isSecretDescriptor(value: object): boolean {
  return !Array.isArray(value) && 'type' in value && secretDescriptorTypes.has(value.type)
}

type JsonState = {
  readonly visiting: Set<object>
  nodes: number
  characters: number
}
