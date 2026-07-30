import type {
  CryptoProvider,
  HmacInput,
  HmacVerifyResult,
  RandomStringOptions,
  VerifyHmacInput
} from '@authmodules/contracts/crypto'
import type { MethodFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import type { ProtectedValue, RawSecretValue } from '@authmodules/contracts/security'
import { methodErr } from '../shared/errors.ts'
import { ok } from '../shared/result.ts'

export function safeRandomSecretString(
  crypto: CryptoProvider,
  input: RandomStringOptions
): Result<RawSecretValue<string>, MethodFailure> {
  try {
    const value = crypto.randomSecretString(input)
    const snapshot = snapshotRawStringSecret(value, input)
    return snapshot
      ? ok(snapshot)
      : methodErr('CRYPTO_FAILED')
  } catch {
    return methodErr('CRYPTO_FAILED')
  }
}

export async function safeHmac(
  crypto: CryptoProvider,
  input: HmacInput
): Promise<Result<ProtectedValue, MethodFailure>> {
  try {
    if (typeof input.scheme !== 'string' || input.scheme.length === 0) return methodErr('CRYPTO_FAILED')
    const result = await crypto.hmac(input)
    const snapshot = result?.ok === true
      ? snapshotProtectedValue(result.value, input.scheme)
      : null
    return snapshot
      ? ok(snapshot)
      : methodErr('CRYPTO_FAILED')
  } catch {
    return methodErr('CRYPTO_FAILED')
  }
}

export async function safeVerifyHmac(
  crypto: CryptoProvider,
  input: VerifyHmacInput
): Promise<Result<HmacVerifyResult, MethodFailure>> {
  try {
    if (typeof crypto.verifyHmac !== 'function') return methodErr('CRYPTO_FAILED')
    const result = await crypto.verifyHmac(input)
    const snapshot = result?.ok === true
      ? snapshotHmacVerifyResult(result.value, input)
      : null
    return snapshot
      ? ok(snapshot)
      : methodErr('CRYPTO_FAILED')
  } catch {
    return methodErr('CRYPTO_FAILED')
  }
}

export function isProtectedValue(value: unknown, scheme: string): value is ProtectedValue {
  return snapshotProtectedValue(value, scheme) !== null
}

export function snapshotProtectedValue(value: unknown, scheme: string): ProtectedValue | null {
  if (!isRecord(value)
    || value.type !== 'protected-value'
    || value.scheme !== scheme
    || typeof value.redacted !== 'string'
    || typeof value.revealForPersistence !== 'function'
    || typeof value.toJSON !== 'function') {
    return null
  }
  try {
    const persisted = value.revealForPersistence()
    if (typeof persisted !== 'string'
      || persisted.length === 0
      || persisted.length > 4096
      || !/^[\x20-\x7e]+$/.test(persisted)) return null
    const keyId = value.keyId
    const createdAtSource = value.createdAt
    let createdAtTimestamp: number | undefined
    if (keyId !== undefined && (typeof keyId !== 'string' || keyId.length > 512)) return null
    if (createdAtSource !== undefined) {
      if (!(createdAtSource instanceof Date)) return null
      createdAtTimestamp = Date.prototype.getTime.call(createdAtSource)
      if (!Number.isFinite(createdAtTimestamp)) return null
    }
    return Object.freeze({
      type: 'protected-value' as const,
      scheme,
      redacted: '[REDACTED]',
      ...(keyId === undefined ? {} : { keyId }),
      ...(createdAtTimestamp === undefined ? {} : { createdAt: new Date(createdAtTimestamp) }),
      revealForPersistence() {
        return persisted
      },
      toJSON() {
        return '[REDACTED]'
      }
    })
  } catch {
    return null
  }
}

function snapshotHmacVerifyResult(value: unknown, input: VerifyHmacInput): HmacVerifyResult | null {
  if (!isRecord(value) || typeof value.verified !== 'boolean') return null
  if (!value.verified) return hasOnlyKeys(value, new Set(['verified'])) ? { verified: false } : null
  if (value.needsUpgrade === false) {
    return hasOnlyKeys(value, new Set(['needsUpgrade', 'verified']))
      ? { verified: true, needsUpgrade: false }
      : null
  }
  const upgradedValue = input.framing === 'hmac-sha256.legacy.v1'
    && value.needsUpgrade === true
    && hasOnlyKeys(value, new Set(['needsUpgrade', 'upgradedValue', 'verified']))
    ? snapshotProtectedValue(value.upgradedValue, input.upgradeScheme)
    : null
  return upgradedValue
    ? { verified: true, needsUpgrade: true, upgradedValue }
    : null
}

function snapshotRawStringSecret(
  value: unknown,
  options: RandomStringOptions
): RawSecretValue<string> | null {
  if (!isRecord(value)
    || value.type !== 'raw-secret'
    || typeof value.redacted !== 'string'
    || typeof value.reveal !== 'function'
    || typeof value.toJSON !== 'function') {
    return null
  }
  try {
    const revealed = value.reveal()
    if (typeof revealed !== 'string') return null
    if (options.kind === 'base64url') {
      if (revealed.length !== Math.ceil(options.bytes * 4 / 3)
        || !/^[A-Za-z0-9_-]+$/.test(revealed)) return null
    } else if (revealed.length !== options.length
      || ![...revealed].every((character) => options.alphabet.includes(character))) {
      return null
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
