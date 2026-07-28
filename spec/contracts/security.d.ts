import type { JsonValue } from './primitives.js'

export type RedactedString = string
export type SecretScalar = string | Uint8Array

/** In-memory only. Never persist, log or audit raw secrets. Serializes as redacted. */
export interface RawSecretValue<T extends SecretScalar = string> {
  readonly type: 'raw-secret'
  readonly redacted: RedactedString
  reveal(): T
  toJSON(): RedactedString
}

/** Runtime representation of persisted verifier/hash material. Serializes as redacted by default. */
export interface ProtectedValue {
  readonly type: 'protected-value'
  readonly scheme: string
  readonly redacted: RedactedString
  readonly keyId?: string
  readonly createdAt?: Date
  revealForPersistence(): string
  toJSON(): RedactedString
}

export type StoredProtectedValue = {
  readonly type: 'protected-value'
  readonly scheme: string
  readonly value: string
  readonly keyId?: string
  readonly createdAt?: Date
}

/** Runtime representation of sealed/encrypted secret payload. Serializes as redacted by default. */
export interface SealedSecretValue {
  readonly type: 'sealed-secret'
  readonly algorithm: string
  readonly keyId: string
  readonly redacted: RedactedString
  readonly expiresAt?: Date
  revealCiphertextForPersistence(): string
  toJSON(): RedactedString
}

export type StoredSealedSecretValue = {
  readonly type: 'sealed-secret'
  readonly ciphertext: string
  readonly algorithm: string
  readonly keyId: string
  readonly expiresAt?: Date
}

/** Constructs runtime secret wrappers from framework input and store DTOs. */
export interface SecretFactory {
  raw<T extends SecretScalar = string>(value: T, redacted?: RedactedString): RawSecretValue<T>
  protectedValue(input: StoredProtectedValue): ProtectedValue
  sealedValue(input: StoredSealedSecretValue): SealedSecretValue
}

/** Shallow object by contract. Flatten nested secret-bearing data before passing it to AuthModules. */
export type PrivateData = { readonly [key: string]: JsonValue | ProtectedValue | SealedSecretValue }

/** Delivery carries raw secrets only while dispatching in memory. Durable effects seal them before persistence. Shallow object by contract. */
export type DeliveryData = {
  readonly [key: string]: JsonValue | RawSecretValue
}

/** Persisted delivery data may never contain RawSecretValue or ProtectedValue. Shallow object by contract. */
export type PersistableDeliveryData = {
  readonly [key: string]: JsonValue | SealedSecretValue
}
