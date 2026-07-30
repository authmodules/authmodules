import type { Result } from './result.js'
import type { CryptoFailure } from './errors.js'
import type { RawSecretValue, ProtectedValue, SealedSecretValue, SecretScalar } from './security.js'

export type RandomStringOptions =
  | {
      readonly kind: 'base64url'
      readonly bytes: number
    }
  | {
      readonly kind: 'alphabet'
      readonly alphabet: string
      readonly length: number
    }

export type HashInput = {
  /** Accepts RawSecretValue so methods do not need to reveal OTPs/tokens just to protect them. */
  readonly value: Uint8Array | string | RawSecretValue<SecretScalar>
  readonly scheme?: string
}

export type HashOutput = ProtectedValue

export type HmacFraming = 'hmac-sha256.v2' | 'hmac-sha256.legacy.v1'

export type HmacInput = {
  readonly key: RawSecretValue<SecretScalar>
  readonly value: Uint8Array | string | RawSecretValue<SecretScalar>
  /** Domain-separation context authenticated before the value. */
  readonly context?: string
  /** Required so a framing change can never silently reuse an existing scheme. */
  readonly framing: 'hmac-sha256.v2'
  readonly scheme?: string
}

export type HmacOutput = ProtectedValue

export type VerifyHmacInput =
  | {
      readonly key: RawSecretValue<SecretScalar>
      readonly value: Uint8Array | string | RawSecretValue<SecretScalar>
      readonly context?: string
      readonly framing: 'hmac-sha256.v2'
      readonly scheme: string
      readonly protectedValue: ProtectedValue
    }
  | {
      readonly key: RawSecretValue<SecretScalar>
      readonly value: Uint8Array | string | RawSecretValue<SecretScalar>
      readonly context?: string
      /** Explicit verification-only compatibility path for persisted legacy values. */
      readonly framing: 'hmac-sha256.legacy.v1'
      readonly scheme: string
      readonly protectedValue: ProtectedValue
      readonly upgradeScheme: string
    }

export type HmacVerifyResult =
  | { readonly verified: false }
  | { readonly verified: true; readonly needsUpgrade: false }
  | {
      readonly verified: true
      readonly needsUpgrade: true
      readonly upgradedValue: ProtectedValue
    }

export interface CryptoProvider {
  /** For public ids/non-secret randomness only. */
  randomPublicBytes(size: number): Uint8Array
  /** For OTPs, session tokens, magic-link secrets and other secret material. */
  randomSecretBytes(size: number): RawSecretValue<Uint8Array>
  randomSecretString(options: RandomStringOptions): RawSecretValue<string>
  hash(input: HashInput): Promise<Result<HashOutput, CryptoFailure>>
  hmac(input: HmacInput): Promise<Result<HmacOutput, CryptoFailure>>
  verifyHmac(input: VerifyHmacInput): Promise<Result<HmacVerifyResult, CryptoFailure>>
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean
}

export type HashPasswordInput = {
  readonly password: RawSecretValue<string>
  readonly now: Date
}

export type VerifyPasswordInput = {
  readonly password: RawSecretValue<string>
  readonly protectedPassword: ProtectedValue
  readonly now: Date
}

export type PasswordVerifyResult =
  | {
      readonly verified: true
      readonly needsRehash: false
    }
  | {
      readonly verified: true
      readonly needsRehash: true
      readonly upgradedValue: ProtectedValue
    }
  | {
      readonly verified: false
    }

export interface PasswordHasher {
  hashPassword(input: HashPasswordInput): Promise<Result<ProtectedValue, CryptoFailure>>
  verifyPassword(input: VerifyPasswordInput): Promise<Result<PasswordVerifyResult, CryptoFailure>>
}

export type SealInput<T extends SecretScalar = string> = {
  readonly value: RawSecretValue<T>
  readonly purpose: string
  readonly expiresAt?: Date
}

export type UnsealInput = {
  readonly value: SealedSecretValue
  readonly purpose: string
  /** Expired sealed values must fail closed before plaintext is returned. */
  readonly now: Date
}

export interface SecretSealer {
  seal<T extends SecretScalar = string>(input: SealInput<T>): Promise<Result<SealedSecretValue, CryptoFailure>>
  unseal<T extends SecretScalar = string>(input: UnsealInput): Promise<Result<RawSecretValue<T>, CryptoFailure>>
}
