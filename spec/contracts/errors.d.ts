import type { ExtensionString, PublicData } from './primitives.js'
export type PublicAuthErrorCode =
  | 'INVALID_INPUT'
  | 'AUTHENTICATION_FAILED'
  | 'AUTHORIZATION_FAILED'
  | 'ACCOUNT_UNAVAILABLE'
  | 'CHALLENGE_FAILED'
  | 'SESSION_INVALID'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'INTERNAL'

export type PublicAuthError = {
  readonly code: PublicAuthErrorCode
  /** Public-safe/localizable. Must not include internal reasons, provider errors, raw input, secrets or stack traces. */
  readonly message?: string
  readonly requestId?: string
  readonly retryAfterSeconds?: number
  readonly publicDetails?: PublicData
}

export type CoreInternalAuthReason =
  | 'CONFIG_INVALID'
  | 'VALIDATION_FAILED'
  | 'METHOD_NOT_CONFIGURED'
  | 'METHOD_OPERATION_UNSUPPORTED'
  | 'METHOD_DISABLED'
  | 'TENANT_DISABLED'
  | 'IDENTITY_NOT_FOUND'
  | 'IDENTITY_CONFLICT'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_CONFLICT'
  | 'CREDENTIAL_DISABLED'
  | 'PASSWORD_MISMATCH'
  | 'PASSWORD_POLICY_FAILED'
  | 'IDENTITY_BINDING_MISMATCH'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_DISABLED'
  | 'ACCOUNT_DELETED'
  | 'ACCOUNT_RESOLUTION_FAILED'
  | 'ACCOUNT_LINKING_DENIED'
  | 'SESSION_CREATION_DENIED'
  | 'SESSION_TTL_INVALID'
  | 'POLICY_DENIED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_TENANT_MISMATCH'
  | 'TOKEN_HASH_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'CHALLENGE_STORE_REQUIRED'
  | 'CHALLENGE_NOT_FOUND'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_CONSUMED'
  | 'CHALLENGE_VERSION_CONFLICT'
  | 'CHALLENGE_ATTEMPTS_EXCEEDED'
  | 'OTP_MISMATCH'
  | 'RATE_LIMITED'
  | 'LOCKED'
  | 'STORE_UNAVAILABLE'
  | 'TRANSACTION_FAILED'
  | 'DELIVERY_FAILED'
  | 'SIDE_EFFECT_FAILED'
  | 'EVENT_SINK_FAILED'
  | 'CRYPTO_FAILED'
  | 'INTERNAL'

export type InternalAuthReason = CoreInternalAuthReason | ExtensionString

export type AuthFailure = {
  readonly type: 'auth.failure'
  readonly publicError: PublicAuthError
  readonly internalReason: InternalAuthReason
  readonly internalDetails?: PublicData
}

export type ComponentFailure = {
  readonly type: 'component.failure'
  readonly reason: InternalAuthReason
  readonly details?: PublicData
}

export type ConfigValidationFailure = ComponentFailure & {
  readonly component: 'config'
}

export type MethodFailure = ComponentFailure & {
  readonly component: 'method'
  readonly countsAsAttempt?: boolean
  readonly safePublicCodeHint?: PublicAuthErrorCode
}

export type StoreFailure = ComponentFailure & {
  readonly component: 'store'
}

export type TokenFailure = ComponentFailure & {
  readonly component: 'token'
}

export type CarrierFailure = ComponentFailure & {
  readonly component: 'carrier'
}

export type DeliveryFailure = ComponentFailure & {
  readonly component: 'delivery'
}

export type SideEffectFailure = ComponentFailure & {
  readonly component: 'effects'
}

export type CryptoFailure = ComponentFailure & {
  readonly component: 'crypto'
}

export type EventSinkFailure = ComponentFailure & {
  readonly component: 'event-sink'
}

export type GuardFailure = ComponentFailure & {
  readonly component: 'guard'
}
