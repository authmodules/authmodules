import type {
  HashPasswordInput,
  PasswordHasher,
  PasswordVerifyResult,
  VerifyPasswordInput
} from '@authmodules/contracts/crypto'
import type { MethodFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import type { ProtectedValue } from '@authmodules/contracts/security'
import { methodErr } from '../shared/errors.ts'

export async function safeHashPassword(
  passwordHasher: PasswordHasher,
  input: HashPasswordInput
): Promise<Result<ProtectedValue, MethodFailure>> {
  try {
    const result = await passwordHasher.hashPassword(input)
    if (result?.ok !== true || !isProtectedValue(result.value)) {
      return methodErr('CRYPTO_FAILED')
    }
    const snapshot = snapshotProtectedValue(result.value)
    return snapshot ? { ok: true, value: snapshot } : methodErr('CRYPTO_FAILED')
  } catch {
    return methodErr('CRYPTO_FAILED')
  }
}

export async function safeVerifyPassword(
  passwordHasher: PasswordHasher,
  input: VerifyPasswordInput
): Promise<Result<PasswordVerifyResult, MethodFailure>> {
  try {
    const result = await passwordHasher.verifyPassword(input)
    if (result?.ok !== true || typeof result.value?.verified !== 'boolean') {
      return methodErr('CRYPTO_FAILED')
    }
    const value = result.value
    if (!value.verified) {
      if (Object.hasOwn(value, 'needsRehash') || Object.hasOwn(value, 'upgradedValue')) {
        return methodErr('CRYPTO_FAILED')
      }
      return { ok: true, value: { verified: false } }
    }
    if (!Object.hasOwn(value, 'needsRehash')) return methodErr('CRYPTO_FAILED')
    if (value.needsRehash === false) {
      if (Object.hasOwn(value, 'upgradedValue')) return methodErr('CRYPTO_FAILED')
      return { ok: true, value: { verified: true, needsRehash: false } }
    }
    const upgradedCandidate = value.upgradedValue
    if (!isProtectedValue(upgradedCandidate)) {
      return methodErr('CRYPTO_FAILED')
    }
    const upgradedValue = snapshotProtectedValue(upgradedCandidate)
    if (!upgradedValue) return methodErr('CRYPTO_FAILED')
    return {
      ok: true,
      value: {
        verified: true,
        needsRehash: true,
        upgradedValue
      }
    }
  } catch {
    return methodErr('CRYPTO_FAILED')
  }
}

export function isProtectedValue(value: unknown): value is ProtectedValue {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'protected-value'
    && 'scheme' in value
    && typeof value.scheme === 'string'
    && value.scheme.length > 0
    && 'redacted' in value
    && typeof value.redacted === 'string'
    && 'revealForPersistence' in value
    && typeof value.revealForPersistence === 'function'
    && 'toJSON' in value
    && typeof value.toJSON === 'function'
}

function snapshotProtectedValue(value: ProtectedValue): ProtectedValue | null {
  try {
    const verifier = value.revealForPersistence()
    const scheme = value.scheme
    const keyId = value.keyId
    const createdAtSource = value.createdAt
    let createdAtTimestamp: number | undefined
    if (createdAtSource !== undefined) {
      if (!(createdAtSource instanceof Date)) return null
      createdAtTimestamp = Date.prototype.getTime.call(createdAtSource)
      if (!Number.isFinite(createdAtTimestamp)) return null
    }
    if (typeof verifier !== 'string'
      || verifier.length === 0
      || verifier.length > 1_000_000
      || !isSafeText(scheme, 256)
      || (keyId !== undefined && !isSafeText(keyId, 512))) {
      return null
    }
    return Object.freeze({
      type: 'protected-value' as const,
      scheme,
      redacted: '[REDACTED]',
      keyId,
      createdAt: createdAtTimestamp === undefined ? undefined : new Date(createdAtTimestamp),
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

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}
