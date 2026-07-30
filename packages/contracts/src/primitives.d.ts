export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export type JsonObject = { readonly [key: string]: JsonValue }
export type JsonArray = readonly JsonValue[]

/** Safe extension data. Must not contain raw secrets, protected values or sealed secrets. */
export type PublicData = { readonly [key: string]: JsonValue }

/** Keeps stable string unions extensible without collapsing autocomplete to plain string. */
export type ExtensionString = string & {}

export type TenantId = string
export type AccountId = string
export type IdentityId = string
export type CredentialId = string
export type SessionId = string
export type ChallengeId = string
export type RequestId = string

export type MethodKind = string
export type MethodId = string
export type Subject = string
export type SubjectKind = string

export type AuthOperationName =
  | 'enroll'
  | 'authenticate'
  | 'begin'
  | 'complete'
  | 'getSession'
  | 'revokeSession'

export type CoreIdKind = 'account' | 'identity' | 'credential' | 'session' | 'challenge'
export type IdKind = CoreIdKind | ExtensionString

export type IdGenerationInput = {
  readonly kind: IdKind
  readonly tenantId?: TenantId
  readonly now?: Date
}

export type MethodRef = {
  readonly methodId: MethodId
  readonly methodKind: MethodKind
}

export type SubjectRef = MethodRef & {
  /** Canonical, normalized subject used for identity uniqueness. */
  readonly subject: Subject
  readonly subjectKind: SubjectKind
  /** Non-canonical UI/display value. Must not be used for uniqueness. */
  readonly display?: string
}

export type IdentityLookup = SubjectRef

export type IdentityClaim = SubjectRef & {
  readonly verifiedAt?: Date
}

export type AuthEvidence = {
  readonly kind: string
  readonly method: MethodRef
  readonly details?: PublicData
}

export type AuthAssurance = {
  readonly level: 'low' | 'medium' | 'high'
  readonly factors?: readonly string[]
}

/** Proof must never contain RawSecretValue, ProtectedValue or SealedSecretValue. */
export type AuthProof = {
  readonly type: 'auth.proof'
  readonly proofMethod: MethodRef
  readonly primaryIdentity: IdentityClaim
  /** Additional proof evidence only; core validates uniqueness but does not persist or link these identities. */
  readonly additionalIdentities?: readonly IdentityClaim[]
  readonly evidence: readonly AuthEvidence[]
  readonly assurance?: AuthAssurance
  readonly authTime: Date
  readonly expiresAt?: Date
  readonly claims?: PublicData
}

export type Actor =
  | { readonly type: 'anonymous' }
  | { readonly type: 'account'; readonly accountId: AccountId }
  | { readonly type: 'system'; readonly name: string }


/** Privacy-narrowed context for dispatch/delivery boundaries. Derived from AuthContext. */
export type DispatchContext = {
  readonly tenantId: TenantId
  readonly requestId?: RequestId
  readonly locale?: string
  /** Safe dispatcher/delivery metadata only. Must not include raw secrets, actor, IP, user agent or policy-only inputs. */
  readonly metadata?: PublicData
}

export type AuthContext = {
  readonly tenantId: TenantId
  readonly requestId?: RequestId
  readonly actor?: Actor
  readonly ip?: string
  readonly userAgent?: string
  readonly locale?: string
  /** May affect policy decisions. */
  readonly policyInput?: PublicData
  /** Observability/debug decoration only; must not affect auth decisions. */
  readonly metadata?: PublicData
}

/** Decision-safe projection of AuthContext. Observability metadata is intentionally unavailable. */
export type DecisionAuthContext = {
  readonly tenantId: TenantId
  readonly requestId?: RequestId
  readonly actor?: Actor
  readonly ip?: string
  readonly userAgent?: string
  readonly locale?: string
  /** The only open-ended request data that may affect auth decisions. */
  readonly policyInput?: PublicData
}

export type AccountResolutionMode =
  | { readonly mode: 'create-new-account' }
  | { readonly mode: 'require-existing-identity' }
  | { readonly mode: 'create-account-if-identity-missing' }
  | { readonly mode: 'link-to-actor-account' }

/**
 * Enrollment may create a new account or link a new identity/credential to the
 * currently authenticated account. It must never attach new credential
 * material to an unrelated existing identity.
 */
export type EnrollmentAccountResolutionMode =
  | { readonly mode: 'create-new-account' }
  | { readonly mode: 'link-to-actor-account' }

/** Presence means “create a session”; absence means “do not create a session”. */
export type CreateSessionRequest = {
  readonly ttlSeconds?: number
}

/** Stored with a challenge during begin; complete reuses it and cannot change account/session intent. */
export type ChallengeBinding = {
  readonly account: AccountResolutionMode
  readonly session?: CreateSessionRequest
  /** Diagnostic/binding context only. Complete must re-check the current AuthContext.actor. */
  readonly startedByActor?: Actor
}

export interface Clock {
  now(): Date
}

/** Generic ID generator. Extension packages may request their own stable string kinds. */
export interface IdGenerator {
  generate(input: IdGenerationInput): string
}
