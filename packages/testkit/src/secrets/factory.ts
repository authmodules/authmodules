import type {
  ProtectedValue,
  RawSecretValue,
  RedactedString,
  SealedSecretValue,
  SecretFactory,
  SecretScalar,
  StoredProtectedValue,
  StoredSealedSecretValue
} from '@authmodules/contracts/security'

export const DEFAULT_REDACTED = '[REDACTED]'

export function createSecretFactory(options?: { readonly redacted?: RedactedString }): SecretFactory

export function createSecretFactory(options: { readonly redacted?: RedactedString } = {}): SecretFactory {
  const defaultRedacted = options.redacted ?? DEFAULT_REDACTED

  return Object.freeze({
    raw<T extends SecretScalar = string>(value: T, redacted: RedactedString = defaultRedacted): RawSecretValue<T> {
      return makeRawSecret(value, redacted)
    },
    protectedValue(input: StoredProtectedValue): ProtectedValue {
      return makeProtectedValue(input, defaultRedacted)
    },
    sealedValue(input: StoredSealedSecretValue): SealedSecretValue {
      return makeSealedSecretValue(input, defaultRedacted)
    }
  })
}

export function makeRawSecret<T extends SecretScalar = string>(value: T, redacted?: RedactedString): RawSecretValue<T>

export function makeRawSecret<T extends SecretScalar = string>(
  value: T,
  redacted: RedactedString = DEFAULT_REDACTED
): RawSecretValue<T> {
  const storedValue = cloneSecretScalar(value)
  const storedRedacted = normalizeRedaction(redacted, value)
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

export function makeProtectedValue(input: StoredProtectedValue, redacted?: RedactedString): ProtectedValue

export function makeProtectedValue(
  input: StoredProtectedValue,
  redacted: RedactedString = DEFAULT_REDACTED
): ProtectedValue {
  const scheme = input.scheme
  const value = input.value
  const keyId = input.keyId
  const createdAt = input.createdAt === undefined ? undefined : new Date(input.createdAt.getTime())
  const storedRedacted = normalizeRedaction(redacted, value)
  return Object.freeze({
    type: 'protected-value',
    scheme,
    redacted: storedRedacted,
    keyId,
    createdAt,
    revealForPersistence(): string {
      return value
    },
    toJSON(): RedactedString {
      return storedRedacted
    }
  })
}

export function makeSealedSecretValue(input: StoredSealedSecretValue, redacted?: RedactedString): SealedSecretValue

export function makeSealedSecretValue(
  input: StoredSealedSecretValue,
  redacted: RedactedString = DEFAULT_REDACTED
): SealedSecretValue {
  const algorithm = input.algorithm
  const keyId = input.keyId
  const ciphertext = input.ciphertext
  const expiresAt = input.expiresAt === undefined ? undefined : new Date(input.expiresAt.getTime())
  const storedRedacted = normalizeRedaction(redacted, ciphertext)
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

function normalizeRedaction(redacted: RedactedString, secret: SecretScalar): RedactedString {
  if (typeof redacted !== 'string'
    || redacted.length === 0
    || redacted.length > 1024
    || /[\u0000-\u001f\u007f]/.test(redacted)
    || secretRepresentations(secret).some(
      (representation) => representation.length > 0
        && (redacted.includes(representation) || representation.includes(redacted))
    )) {
    return DEFAULT_REDACTED
  }
  return redacted
}

function secretRepresentations(secret: SecretScalar): readonly string[] {
  if (typeof secret === 'string') return [secret]
  const bytes = Buffer.from(secret)
  return [
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
    bytes.toString('utf8')
  ]
}
