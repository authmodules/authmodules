import type { OtpMethodOptions } from './types.ts'
import type { RawSecretValue, SecretScalar } from '@authmodules/contracts/security'

export function normalizeOtpOptions(options: unknown): OtpMethodOptions {
  if (!isRecord(options)) throw new TypeError('OTP crypto and verificationKey are required.')
  const candidate = options as Partial<OtpMethodOptions>
  const crypto = candidate.crypto
  const verificationKeySource = candidate.verificationKey
  const ttlSeconds = candidate.ttlSeconds ?? 300
  const maxAttempts = candidate.maxAttempts ?? 5
  const codeLength = candidate.codeLength ?? 6
  const alphabet = candidate.alphabet ?? '0123456789'
  const methodId = candidate.methodId ?? 'otp.email'
  const subjectKind = candidate.subjectKind ?? 'email'
  const channel = candidate.channel ?? subjectKind
  const templateId = candidate.templateId ?? 'authmodules.otp'
  const resolveDeliveryTarget = candidate.resolveDeliveryTarget
  if (!crypto
    || typeof crypto.randomSecretString !== 'function'
    || typeof crypto.hmac !== 'function'
    || typeof crypto.verifyHmac !== 'function'
    || typeof verificationKeySource?.reveal !== 'function') {
    throw new TypeError('OTP crypto and verificationKey are required.')
  }

  let revealedKey: SecretScalar
  try {
    revealedKey = verificationKeySource.reveal()
  } catch {
    throw new TypeError('OTP verificationKey is invalid.')
  }
  if (!((typeof revealedKey === 'string' && revealedKey.length >= 32 && revealedKey.length <= 4096)
    || (revealedKey instanceof Uint8Array && revealedKey.byteLength >= 32 && revealedKey.byteLength <= 4096))) {
    throw new TypeError('OTP verificationKey must contain at least 32 bytes of key material.')
  }

  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0
    || ttlSeconds > 3600
    || !Number.isSafeInteger(maxAttempts) || maxAttempts <= 0
    || maxAttempts > 100
    || !Number.isSafeInteger(codeLength) || codeLength <= 0 || codeLength > 128
    || typeof alphabet !== 'string' || alphabet.length < 2 || alphabet.length > 256
    || !/^[\x21-\x7e]+$/.test(alphabet)
    || new Set(alphabet).size !== alphabet.length
    || codeLength * Math.log2(alphabet.length) < Math.log2(1_000_000)
    || !isStableMethodId(methodId)
    || !isSafeText(subjectKind, 128) || subjectKind.length === 0
    || !isSafeText(channel, 64) || channel.length === 0
    || !isSafeText(templateId, 256) || templateId.length === 0
    || (resolveDeliveryTarget !== undefined && typeof resolveDeliveryTarget !== 'function')) {
    throw new TypeError('OTP configuration values are invalid.')
  }
  return Object.freeze({
    crypto,
    verificationKey: snapshotRawSecret(revealedKey),
    ttlSeconds,
    maxAttempts,
    codeLength,
    alphabet,
    methodId,
    subjectKind,
    channel,
    templateId,
    resolveDeliveryTarget
  })
}

function isStableMethodId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value)
}

export function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snapshotRawSecret(value: SecretScalar): RawSecretValue<SecretScalar> {
  const stored = value instanceof Uint8Array ? new Uint8Array(value) : value
  return Object.freeze({
    type: 'raw-secret' as const,
    redacted: '[REDACTED]',
    reveal() {
      return stored instanceof Uint8Array ? new Uint8Array(stored) : stored
    },
    toJSON() {
      return '[REDACTED]'
    }
  })
}
