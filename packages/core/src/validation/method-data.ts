import type { ChallengeMaterial, CredentialMaterial } from '@authmodules/contracts/material'
import type { ValidatedMethodInput } from '@authmodules/contracts/method'
import type { IdentityClaim, IdentityLookup } from '@authmodules/contracts/primitives'
import type { ProtectedValue, SealedSecretValue } from '@authmodules/contracts/security'
import { isNonEmptyString, isPublicData, isValidDate } from './input.ts'
import { isStableMethodId } from './method.ts'

const identityKeys = new Set(['display', 'methodId', 'methodKind', 'subject', 'subjectKind'])
const identityClaimKeys = new Set([...identityKeys, 'verifiedAt'])
const materialKeys = new Set(['privateData', 'publicData', 'schemaVersion'])
const protectedValueKeys = new Set([
  'createdAt',
  'keyId',
  'redacted',
  'revealForPersistence',
  'scheme',
  'toJSON',
  'type'
])
const sealedValueKeys = new Set([
  'algorithm',
  'expiresAt',
  'keyId',
  'redacted',
  'revealCiphertextForPersistence',
  'toJSON',
  'type'
])
const validatedInputKeys = new Set(['lookup', 'publicData', 'value'])

export function isValidatedMethodInput(value: unknown): value is ValidatedMethodInput<unknown> {
  return isRecord(value)
    && hasOnlyKeys(value, validatedInputKeys)
    && 'value' in value
    && isIdentityLookup(value.lookup)
    && isPublicData(value.publicData)
}

export function isIdentityLookup(value: unknown): value is IdentityLookup | undefined {
  return value === undefined || (isRecord(value)
    && hasOnlyKeys(value, identityKeys)
    && isStableMethodId(value.methodId)
    && isNonEmptyString(value.methodKind)
    && isNonEmptyString(value.subject)
    && isNonEmptyString(value.subjectKind)
    && (value.display === undefined || isSafeDisplay(value.display)))
}

export function isIdentityClaim(value: unknown, now: Date): value is IdentityClaim {
  return isRecord(value)
    && hasOnlyKeys(value, identityClaimKeys)
    && isStableMethodId(value.methodId)
    && isNonEmptyString(value.methodKind)
    && isNonEmptyString(value.subject)
    && isNonEmptyString(value.subjectKind)
    && (value.display === undefined || isSafeDisplay(value.display))
    && (value.verifiedAt === undefined || (isValidDate(value.verifiedAt) && value.verifiedAt <= now))
}

export function isMethodMaterial(
  value: unknown
): value is CredentialMaterial | ChallengeMaterial | undefined {
  return value === undefined || (isRecord(value)
    && hasOnlyKeys(value, materialKeys)
    && isNonEmptyString(value.schemaVersion)
    && isPublicData(value.publicData)
    && isPrivateData(value.privateData))
}

function isPrivateData(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || Object.keys(value).length > 1000) return false
  return Object.entries(value).every(([key, item]) => isSafeKey(key)
    && (isProtectedValue(item) || isSealedValue(item) || isPublicData({ value: item })))
}

function isProtectedValue(value: unknown): value is ProtectedValue {
  return isRecord(value)
    && hasOnlyKeys(value, protectedValueKeys)
    && value.type === 'protected-value'
    && isNonEmptyString(value.scheme)
    && isSafeText(value.redacted, 1024, false)
    && (value.keyId === undefined || isSafeText(value.keyId, 512, false))
    && (value.createdAt === undefined || isValidDate(value.createdAt))
    && typeof value.revealForPersistence === 'function'
    && typeof value.toJSON === 'function'
}

function isSealedValue(value: unknown): value is SealedSecretValue {
  return isRecord(value)
    && hasOnlyKeys(value, sealedValueKeys)
    && value.type === 'sealed-secret'
    && isNonEmptyString(value.algorithm)
    && isNonEmptyString(value.keyId)
    && isSafeText(value.redacted, 1024, false)
    && (value.expiresAt === undefined || isValidDate(value.expiresAt))
    && typeof value.revealCiphertextForPersistence === 'function'
    && typeof value.toJSON === 'function'
}

function isSafeDisplay(value: unknown): value is string {
  return isSafeText(value, 512, false)
}

function isSafeKey(value: string): boolean {
  return isSafeText(value, 512, true)
}

function isSafeText(value: unknown, maxLength: number, requireNonEmpty: boolean): value is string {
  return typeof value === 'string'
    && (!requireNonEmpty || value.length > 0)
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
