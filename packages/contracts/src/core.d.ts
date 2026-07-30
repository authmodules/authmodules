import type { Result } from './result.js'
import type {
  AccountId,
  AuthContext,
  AuthOperationName,
  AuthProof,
  ChallengeId,
  IdGenerator,
  IdentityClaim,
  IdentityLookup,
  MethodId,
  MethodRef,
  PublicData,
  SessionId,
  Clock,
  AccountResolutionMode,
  EnrollmentAccountResolutionMode,
  CreateSessionRequest,
  DecisionAuthContext,
} from './primitives.js'
import type { RawSecretValue } from './security.js'
import type { AuthFailure, ConfigValidationFailure, PublicAuthErrorCode } from './errors.js'
import type { MethodRegistry } from './method.js'
import type { AuthStore } from './store.js'
import type { TokenFormat, IssuedTokenView } from './token.js'
import type { SideEffectDispatcher } from './effects.js'
import type { AuthEventSink } from './observability.js'
import type { AccountView, CredentialView, IdentityView, SessionView } from './views.js'
import type { AuthGuard } from './guard.js'

export type SessionConfig = {
  /** Positive safe integer seconds used when session: {} omits ttlSeconds. Maximum supported value is 3,155,760,000 seconds. */
  readonly defaultTtlSeconds: number
  /** Optional positive safe integer upper bound for per-call ttlSeconds, never above 3,155,760,000 seconds. */
  readonly maxTtlSeconds?: number
}

export type EnrollInput = {
  readonly context: AuthContext
  readonly methodId: MethodId
  readonly input: unknown
  readonly account: EnrollmentAccountResolutionMode
  readonly session?: CreateSessionRequest
}

export type AuthenticateInput = {
  readonly context: AuthContext
  readonly methodId: MethodId
  readonly input: unknown
  readonly session?: CreateSessionRequest
}

export type BeginInput = {
  readonly context: AuthContext
  readonly methodId: MethodId
  readonly input: unknown
  readonly account: AccountResolutionMode
  /** Stored in ChallengeRecord.binding and reused during complete. */
  readonly session?: CreateSessionRequest
}

export type CompleteInput = {
  readonly context: AuthContext
  /** Core loads ChallengeRecord by id and uses ChallengeRecord.methodId to select the method. */
  readonly challengeId: ChallengeId
  readonly input: unknown
}

export type GetSessionInput = {
  readonly context: AuthContext
  /** Missing token is a normal anonymous/no-active-session case and returns ok=true, value=null. */
  readonly token?: RawSecretValue<string>
}

export type RevokeSessionInput = {
  readonly context: AuthContext
  readonly sessionId: SessionId
}

export type AuthSuccess = {
  readonly account: AccountView
  readonly session?: SessionView
  readonly token?: IssuedTokenView
  readonly proof: AuthProof
  readonly publicData?: PublicData
}

export type EnrollSuccess = {
  readonly account: AccountView
  readonly identity: IdentityView
  readonly credential?: CredentialView
  readonly proof?: AuthProof
  readonly session?: SessionView
  readonly token?: IssuedTokenView
  readonly publicData?: PublicData
}

export type AuthBeginResult = {
  readonly challengeId: ChallengeId
  readonly expiresAt: Date
  readonly publicData?: PublicData
}

export interface Auth {
  enroll(input: EnrollInput): Promise<Result<EnrollSuccess, AuthFailure>>
  authenticate(input: AuthenticateInput): Promise<Result<AuthSuccess, AuthFailure>>
  begin(input: BeginInput): Promise<Result<AuthBeginResult, AuthFailure>>
  complete(input: CompleteInput): Promise<Result<AuthSuccess, AuthFailure>>
  getSession(input: GetSessionInput): Promise<Result<SessionView | null, AuthFailure>>
  revokeSession(input: RevokeSessionInput): Promise<Result<void, AuthFailure>>
}

export type PolicyDenyReason =
  | 'POLICY_DENIED'
  | 'METHOD_DISABLED'
  | 'TENANT_DISABLED'
  | 'ACCOUNT_LINKING_DENIED'
  | 'SESSION_CREATION_DENIED'
  | 'ACCOUNT_RESOLUTION_DENIED'

export type PolicyDecision =
  | { readonly allow: true }
  | {
      readonly allow: false
      readonly reason: PolicyDenyReason
      readonly publicCodeHint?: PublicAuthErrorCode
    }

export type PolicyCheck =
  | {
      readonly kind: 'start-attempt'
      readonly context: DecisionAuthContext
      readonly method: MethodRef
      readonly operation: AuthOperationName
      readonly lookup?: IdentityLookup
      readonly publicData?: PublicData
    }
  | {
      readonly kind: 'accept-enrollment'
      readonly context: DecisionAuthContext
      readonly method: MethodRef
      readonly identity: IdentityClaim
      readonly hasCredentialMaterial: boolean
      readonly publicData?: PublicData
    }
  | { readonly kind: 'accept-proof'; readonly context: DecisionAuthContext; readonly proof: AuthProof }
  | {
      readonly kind: 'resolve-account'
      readonly context: DecisionAuthContext
      readonly proof?: AuthProof
      readonly identity?: IdentityClaim
      readonly lookup?: IdentityLookup
      readonly mode: AccountResolutionMode
    }
  | {
      readonly kind: 'create-session'
      readonly context: DecisionAuthContext
      readonly accountId: AccountId
      readonly proof: AuthProof
      readonly requestedTtlSeconds?: number
      readonly resolvedTtlSeconds: number
      readonly expiresAt: Date
    }
  | {
      readonly kind: 'revoke-session'
      readonly context: DecisionAuthContext
      readonly sessionId: SessionId
      /** Present when core found the session before revocation; absent must not leak existence. */
      readonly session?: SessionView
    }

/** One stable policy hook. Helpers may adapt object-style policies to this function. */
export type CorePolicy = (check: PolicyCheck) => Promise<PolicyDecision> | PolicyDecision

export type CreateAuthConfig = {
  readonly store: AuthStore
  readonly methods: MethodRegistry
  readonly token: TokenFormat
  /** Source of truth for session TTL when callers request session creation. */
  readonly session: SessionConfig
  /** Optional side effect dispatcher. Runtime required side effects fail if no dispatcher is configured. */
  readonly effects?: SideEffectDispatcher
  readonly policy?: CorePolicy
  /** Stable optional production-hardening hook. Not required by baseline. */
  readonly guard?: AuthGuard
  readonly eventSink?: AuthEventSink
  readonly clock: Clock
  readonly idGenerator: IdGenerator
}

export declare function createAuth(config: CreateAuthConfig): Result<Auth, ConfigValidationFailure>
