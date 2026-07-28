import type { Result, ValidationFailure } from './result.js'
import type {
  AuthProof,
  ChallengeId,
  CredentialId,
  DecisionAuthContext,
  IdentityId,
  IdentityLookup,
  MethodId,
  MethodKind,
  IdentityClaim,
  MethodRef,
  PublicData,
} from './primitives.js'
import type { MethodFailure } from './errors.js'
import type { CredentialMaterial, ChallengeMaterial } from './material.js'
import type { SideEffectRequest } from './effects.js'

export type MethodValidationContext = {
  readonly method: MethodRef
  readonly auth: DecisionAuthContext
  readonly now: Date
}

export type ValidatedMethodInput<I = unknown> = {
  /**
   * Core snapshots this value before asynchronous policy or persistence work.
   * Values must be finite primitives, Date, Uint8Array, dense arrays, plain objects,
   * or supported AuthModules secret wrappers. Accessors, symbols, class instances,
   * sparse arrays, cycles, and oversized structures are rejected.
   */
  readonly value: I
  /** Canonical lookup usable by core before method.run, when the input already identifies a subject. */
  readonly lookup?: IdentityLookup
  readonly publicData?: PublicData
}

export type MethodValidator<I = unknown> = (
  input: unknown,
  context: MethodValidationContext,
) => Result<ValidatedMethodInput<I>, ValidationFailure>

export type MethodIdentityContext = {
  readonly identityId?: IdentityId
  readonly credentialId?: CredentialId
  readonly credentialMaterial?: CredentialMaterial
}

export type NewChallengeContext = {
  readonly challengeId: ChallengeId
}

export type ExistingChallengeContext = {
  readonly challengeId: ChallengeId
  readonly challengeMaterial: ChallengeMaterial
}

export type MethodExecutionContext = {
  readonly method: MethodRef
  readonly auth: DecisionAuthContext
  readonly now: Date
  /** Canonical lookup returned by validate() or stored challenge lookup, if known. */
  readonly lookup?: IdentityLookup
  readonly identity?: MethodIdentityContext
}

export type MethodEnrollResult = {
  /** Identity claim to create/link. Must match validation lookup when lookup exists. */
  readonly identity: IdentityClaim
  readonly credentialMaterial?: CredentialMaterial
  /** Core may create a session after enroll only when proof is present. */
  readonly proof?: AuthProof
  readonly sideEffects?: readonly SideEffectRequest[]
  readonly publicData?: PublicData
}

export type MethodAuthenticateResult = {
  readonly proof: AuthProof
  /** Full replacement for method-owned credential material. Core/store own expected record version. */
  readonly credentialMaterial?: CredentialMaterial
  readonly sideEffects?: readonly SideEffectRequest[]
  readonly publicData?: PublicData
}

export type MethodBeginResult = {
  readonly challengeMaterial: ChallengeMaterial
  readonly expiresAt: Date
  /** Challenge attempts are method-owned semantics and must be explicit. */
  readonly maxAttempts: number
  readonly sideEffects?: readonly SideEffectRequest[]
  readonly publicData?: PublicData
}

export type MethodCompleteResult = {
  readonly proof: AuthProof
  readonly sideEffects?: readonly SideEffectRequest[]
  readonly publicData?: PublicData
}

export type MethodEnrollOperation<I = unknown> = {
  readonly validate: MethodValidator<I>
  readonly run: (input: I, context: MethodExecutionContext) => Promise<Result<MethodEnrollResult, MethodFailure>>
}

export type MethodAuthenticateOperation<I = unknown> = {
  readonly validate: MethodValidator<I>
  readonly run: (input: I, context: MethodExecutionContext) => Promise<Result<MethodAuthenticateResult, MethodFailure>>
}

export type MethodBeginOperation<I = unknown> = {
  readonly validate: MethodValidator<I>
  readonly run: (input: I, context: MethodExecutionContext & { readonly challenge: NewChallengeContext }) => Promise<Result<MethodBeginResult, MethodFailure>>
}

export type MethodCompleteOperation<I = unknown> = {
  readonly validate: MethodValidator<I>
  readonly run: (input: I, context: MethodExecutionContext & { readonly challenge: ExistingChallengeContext }) => Promise<Result<MethodCompleteResult, MethodFailure>>
}

type BivariantMethodRunner<C, R> = {
  run(input: unknown, context: C): Promise<Result<R, MethodFailure>>
}['run']

export type AnyMethodEnrollOperation = {
  readonly validate: MethodValidator<unknown>
  readonly run: BivariantMethodRunner<MethodExecutionContext, MethodEnrollResult>
}

export type AnyMethodAuthenticateOperation = {
  readonly validate: MethodValidator<unknown>
  readonly run: BivariantMethodRunner<MethodExecutionContext, MethodAuthenticateResult>
}

export type AnyMethodBeginOperation = {
  readonly validate: MethodValidator<unknown>
  readonly run: BivariantMethodRunner<MethodExecutionContext & { readonly challenge: NewChallengeContext }, MethodBeginResult>
}

export type AnyMethodCompleteOperation = {
  readonly validate: MethodValidator<unknown>
  readonly run: BivariantMethodRunner<MethodExecutionContext & { readonly challenge: ExistingChallengeContext }, MethodCompleteResult>
}

/**
 * Registry boundary intentionally erases method-specific input types.
 * Concrete method implementations remain strongly typed; core calls validate() first
 * and passes only the validated value from that same operation to run().
 */
export type MethodOperations = {
  readonly enroll?: AnyMethodEnrollOperation
  readonly authenticate?: AnyMethodAuthenticateOperation
  readonly begin?: AnyMethodBeginOperation
  readonly complete?: AnyMethodCompleteOperation
}

export type AuthMethod = {
  readonly methodId: MethodId
  readonly methodKind: MethodKind
  /** Subject normalization is owned by method validators and must be deterministic and migration-safe. */
  readonly operations: MethodOperations
}

export type MethodRegistry = Readonly<Record<MethodId, AuthMethod>>
