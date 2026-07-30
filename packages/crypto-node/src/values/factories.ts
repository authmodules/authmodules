import type {
  ProtectedValue,
  RawSecretValue,
  RedactedString,
  SealedSecretValue,
  SecretScalar,
  StoredProtectedValue,
  StoredSealedSecretValue
} from '@authmodules/contracts/security'
import { REDACTED } from '../shared/constants.ts'
import { dateTimestamp, isSafeIdentifier } from '../shared/validation.ts'

export function rawSecret<T extends SecretScalar = string>(value: T, redacted: RedactedString = REDACTED): RawSecretValue<T> {
  if ((typeof value !== 'string' && !(value instanceof Uint8Array))
    || (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 5_000_000)
    || (value instanceof Uint8Array && value.byteLength > 5_000_000)
    || typeof redacted !== 'string') {
    throw new TypeError('Raw secret value is invalid.')
  }
  const storedValue = cloneSecretScalar(value)
  const storedRedacted = normalizedRedaction(redacted, value)
  return Object.freeze({
    type: 'raw-secret',
    redacted: storedRedacted,
    reveal(): T {
      return cloneSecretScalar(storedValue)
    },
    toJSON(): RedactedString {
      return storedRedacted
    }
  })
}

export function protectedValue(input: StoredProtectedValue, redacted: RedactedString = REDACTED): ProtectedValue {
  const type = input?.type
  const scheme = input?.scheme
  const verifier = input?.value
  const keyId = input?.keyId
  const createdAtSource = input?.createdAt
  const createdAtTimestamp = createdAtSource === undefined ? undefined : dateTimestamp(createdAtSource)
  if (type !== 'protected-value'
    || !isSafeIdentifier(scheme, 256)
    || typeof verifier !== 'string' || verifier.length === 0 || verifier.length > 1_000_000
    || (keyId !== undefined && !isSafeIdentifier(keyId, 512))
    || (createdAtSource !== undefined && createdAtTimestamp === undefined)
    || typeof redacted !== 'string') {
    throw new TypeError('Protected value is invalid.')
  }
  const createdAt = createdAtTimestamp === undefined ? undefined : new Date(createdAtTimestamp)
  const storedRedacted = normalizedRedaction(redacted, verifier)
  return Object.freeze({
    type: 'protected-value',
    scheme,
    redacted: storedRedacted,
    keyId,
    createdAt,
    revealForPersistence(): string {
      return verifier
    },
    toJSON(): RedactedString {
      return storedRedacted
    }
  })
}

export function sealedValue(input: StoredSealedSecretValue, redacted: RedactedString = REDACTED): SealedSecretValue {
  const type = input?.type
  const algorithm = input?.algorithm
  const keyId = input?.keyId
  const ciphertext = input?.ciphertext
  const expiresAtSource = input?.expiresAt
  const expiresAtTimestamp = expiresAtSource === undefined ? undefined : dateTimestamp(expiresAtSource)
  if (type !== 'sealed-secret'
    || !isSafeIdentifier(algorithm, 256)
    || !isSafeIdentifier(keyId, 512)
    || typeof ciphertext !== 'string' || ciphertext.length === 0 || ciphertext.length > 5_000_000
    || (expiresAtSource !== undefined && expiresAtTimestamp === undefined)
    || typeof redacted !== 'string') {
    throw new TypeError('Sealed value is invalid.')
  }
  const expiresAt = expiresAtTimestamp === undefined ? undefined : new Date(expiresAtTimestamp)
  const storedRedacted = normalizedRedaction(redacted, ciphertext)
  return Object.freeze({
    type: 'sealed-secret',
    algorithm,
    keyId,
    redacted: storedRedacted,
    expiresAt,
    revealCiphertextForPersistence(): string {
      return ciphertext
    },
    toJSON(): RedactedString {
      return storedRedacted
    }
  })
}

function cloneSecretScalar<T extends SecretScalar>(value: T): T {
  return (value instanceof Uint8Array ? new Uint8Array(value) : value) as T
}

function normalizedRedaction(redacted: string, secret: SecretScalar): RedactedString {
  if (redacted.length === 0
    || redacted.length > 1024
    || /[\u0000-\u001f\u007f]/.test(redacted)
    || [...secretRepresentations(secret)].some(
      (representation) => representation.length > 0
        && (redacted.includes(representation) || representation.includes(redacted))
    )) {
    return REDACTED
  }
  return redacted
}

function secretRepresentations(secret: SecretScalar): ReadonlySet<string> {
  if (typeof secret === 'string') return new Set([secret])
  const bytes = Buffer.from(secret)
  return new Set([
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
    bytes.toString('utf8')
  ])
}
