import type { InternalAuthReason, TokenFailure } from '@authmodules/contracts/errors'
import type { ProtectedValue, RawSecretValue } from '@authmodules/contracts/security'
import type { TokenIdentifyResult, TokenIssueResult } from '@authmodules/contracts/token'
import { isNonEmptyString, isPublicData, isValidDate } from './input.ts'

const failureKeys = new Set(['component', 'details', 'reason', 'type'])
const protectedValueKeys = new Set([
  'createdAt',
  'keyId',
  'redacted',
  'revealForPersistence',
  'scheme',
  'toJSON',
  'type'
])
const rawSecretKeys = new Set(['redacted', 'reveal', 'toJSON', 'type'])
const resultKeys = new Set(['error', 'ok', 'value'])
const tokenHashIdentityKeys = new Set(['claims', 'kind', 'tokenHash'])
const tokenIssueKeys = new Set(['raw', 'tokenHash'])
const tokenSessionIdentityKeys = new Set(['claims', 'kind', 'sessionId', 'tenantId', 'tokenHash'])

export type TokenCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TokenFailure }

export function isTokenIdentifyCallResult(value: unknown): value is TokenCallResult<TokenIdentifyResult> {
  return isTokenCallResult(value, isTokenIdentifyResult)
}

export function isTokenIssueCallResult(value: unknown): value is TokenCallResult<TokenIssueResult> {
  return isTokenCallResult(value, isTokenIssueResult)
}

export function isRawSecret(value: unknown): value is RawSecretValue<string> {
  return isRecord(value)
    && hasOnlyKeys(value, rawSecretKeys)
    && value.type === 'raw-secret'
    && typeof value.redacted === 'string'
    && typeof value.reveal === 'function'
    && typeof value.toJSON === 'function'
}

export function snapshotRawSecret(value: unknown): RawSecretValue<string> | null {
  if (!isRawSecret(value)) return null
  try {
    const revealed = value.reveal()
    if (typeof revealed !== 'string'
      || revealed.length === 0
      || revealed.length > 65_536) return null
    return Object.freeze({
      type: 'raw-secret' as const,
      redacted: '[REDACTED]',
      reveal() {
        return revealed
      },
      toJSON() {
        return '[REDACTED]'
      }
    })
  } catch {
    return null
  }
}

export function snapshotProtectedValue(value: unknown): ProtectedValue | null {
  if (!isProtectedValue(value)) return null
  try {
    const verifier = value.revealForPersistence()
    if (typeof verifier !== 'string' || verifier.length === 0 || verifier.length > 1_000_000) {
      return null
    }
    const scheme = value.scheme
    const keyId = value.keyId
    const createdAt = value.createdAt ? new Date(value.createdAt.getTime()) : undefined
    return Object.freeze({
      type: 'protected-value' as const,
      scheme,
      redacted: '[REDACTED]',
      keyId,
      createdAt,
      revealForPersistence() {
        return verifier
      },
      toJSON() {
        return '[REDACTED]'
      }
    })
  } catch {
    return null
  }
}

function isTokenCallResult<T>(
  value: unknown,
  isSuccessValue: (candidate: unknown) => candidate is T
): value is TokenCallResult<T> {
  if (!isRecord(value) || !hasOnlyKeys(value, resultKeys)) return false
  if (value.ok === true) return !('error' in value) && isSuccessValue(value.value)
  return value.ok === false && !('value' in value) && isTokenFailure(value.error)
}

function isTokenIdentifyResult(value: unknown): value is TokenIdentifyResult {
  if (value === null) return true
  if (!isRecord(value)) return false
  if (value.kind === 'by-token-hash') {
    return hasOnlyKeys(value, tokenHashIdentityKeys)
      && isProtectedValue(value.tokenHash)
      && isPublicData(value.claims)
  }
  return value.kind === 'by-session'
    && hasOnlyKeys(value, tokenSessionIdentityKeys)
    && isNonEmptyString(value.tenantId)
    && isNonEmptyString(value.sessionId)
    && isProtectedValue(value.tokenHash)
    && isPublicData(value.claims)
}

function isTokenIssueResult(value: unknown): value is TokenIssueResult {
  return isRecord(value)
    && hasOnlyKeys(value, tokenIssueKeys)
    && isRawSecret(value.raw)
    && isProtectedValue(value.tokenHash)
}

function isTokenFailure(value: unknown): value is TokenFailure {
  return isRecord(value)
    && hasOnlyKeys(value, failureKeys)
    && value.type === 'component.failure'
    && value.component === 'token'
    && isSafeReason(value.reason)
    && isPublicData(value.details)
}

export function isProtectedValue(value: unknown): value is ProtectedValue {
  return isRecord(value)
    && hasOnlyKeys(value, protectedValueKeys)
    && value.type === 'protected-value'
    && isNonEmptyString(value.scheme)
    && typeof value.redacted === 'string'
    && (value.keyId === undefined || isNonEmptyString(value.keyId))
    && (value.createdAt === undefined || isValidDate(value.createdAt))
    && typeof value.revealForPersistence === 'function'
    && typeof value.toJSON === 'function'
}

function isSafeReason(value: unknown): value is InternalAuthReason {
  return isNonEmptyString(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
