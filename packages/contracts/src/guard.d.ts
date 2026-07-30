import type { Result } from './result.js'
import type {
  AuthOperationName,
  ChallengeId,
  DecisionAuthContext,
  IdentityLookup,
  MethodRef
} from './primitives.js'
import type { GuardFailure, InternalAuthReason, PublicAuthErrorCode } from './errors.js'

export type AuthGuardDecision =
  | { readonly allow: true }
  | {
      readonly allow: false
      readonly publicCodeHint?: Extract<PublicAuthErrorCode, 'RATE_LIMITED' | 'TEMPORARILY_UNAVAILABLE'>
      readonly reason: InternalAuthReason
      readonly retryAfterSeconds?: number
    }

export type GuardBeforeAttemptInput = {
  readonly context: DecisionAuthContext
  readonly method: MethodRef
  readonly operation: AuthOperationName
  readonly lookup?: IdentityLookup
  readonly challengeId?: ChallengeId
}

export type GuardAfterAttemptInput = GuardBeforeAttemptInput & {
  readonly outcome:
    | { readonly success: true }
    | {
        readonly success: false
        readonly reason: InternalAuthReason
        /** Core decides whether this outcome consumes the guard failure budget. */
        readonly countsAsAttempt: boolean
      }
}

/** Production-hardening extension. Not required by baseline compliance. */
export interface AuthGuard {
  beforeAttempt(input: GuardBeforeAttemptInput): Promise<Result<AuthGuardDecision, GuardFailure>>
  afterAttempt(input: GuardAfterAttemptInput): Promise<Result<void, GuardFailure>>
}
