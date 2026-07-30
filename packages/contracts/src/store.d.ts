import type { Result } from './result.js'
import type {
  AccountId,
  ChallengeBinding,
  ChallengeId,
  CredentialId,
  IdentityId,
  IdentityLookup,
  MethodId,
  MethodKind,
  PublicData,
  SessionId,
  Subject,
  SubjectKind,
  TenantId,
} from './primitives.js'
import type { StoreFailure, InternalAuthReason } from './errors.js'
import type { CredentialMaterial, ChallengeMaterial } from './material.js'
import type { ProtectedValue } from './security.js'
import type { TransactionContext, TransactionRunner } from './transaction.js'

export type AccountRecord = {
  readonly tenantId: TenantId
  readonly accountId: AccountId
  readonly status: 'active' | 'disabled' | 'deleted'
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly publicData?: PublicData
}

export type IdentityRecord = {
  readonly tenantId: TenantId
  readonly identityId: IdentityId
  readonly accountId: AccountId
  readonly methodId: MethodId
  readonly methodKind: MethodKind
  readonly subject: Subject
  readonly subjectKind: SubjectKind
  readonly display?: string
  readonly verifiedAt?: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type CredentialRecord = {
  readonly tenantId: TenantId
  readonly credentialId: CredentialId
  readonly accountId: AccountId
  readonly identityId: IdentityId
  readonly methodId: MethodId
  readonly methodKind: MethodKind
  readonly status: 'active' | 'disabled'
  readonly material: CredentialMaterial
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type SessionRecord = {
  readonly tenantId: TenantId
  readonly sessionId: SessionId
  readonly accountId: AccountId
  readonly tokenHash: ProtectedValue
  readonly status: 'active' | 'revoked' | 'expired'
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly revokedAt?: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type ChallengeRecord = {
  readonly tenantId: TenantId
  readonly challengeId: ChallengeId
  readonly methodId: MethodId
  readonly methodKind: MethodKind
  readonly lookup?: IdentityLookup
  readonly status: 'pending' | 'consumed' | 'expired' | 'failed'
  readonly material: ChallengeMaterial
  readonly binding: ChallengeBinding
  readonly attempts: number
  readonly maxAttempts: number
  readonly version: number
  readonly expiresAt: Date
  readonly consumedAt?: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface AccountStore {
  create(input: { readonly record: AccountRecord }, tx?: TransactionContext): Promise<Result<AccountRecord, StoreFailure>>
  findById(input: { readonly tenantId: TenantId; readonly accountId: AccountId }, tx?: TransactionContext): Promise<Result<AccountRecord | null, StoreFailure>>
  updateStatus(input: { readonly tenantId: TenantId; readonly accountId: AccountId; readonly status: AccountRecord['status']; readonly now: Date }, tx?: TransactionContext): Promise<Result<AccountRecord, StoreFailure>>
}

export interface IdentityStore {
  create(input: { readonly record: IdentityRecord }, tx?: TransactionContext): Promise<Result<IdentityRecord, StoreFailure>>
  findById(input: { readonly tenantId: TenantId; readonly identityId: IdentityId }, tx?: TransactionContext): Promise<Result<IdentityRecord | null, StoreFailure>>
  findBySubject(input: { readonly tenantId: TenantId; readonly methodId: MethodId; readonly subject: Subject }, tx?: TransactionContext): Promise<Result<IdentityRecord | null, StoreFailure>>
  markVerified(input: { readonly tenantId: TenantId; readonly identityId: IdentityId; readonly verifiedAt: Date; readonly now: Date }, tx?: TransactionContext): Promise<Result<IdentityRecord, StoreFailure>>
}

export interface CredentialStore {
  create(input: { readonly record: CredentialRecord }, tx?: TransactionContext): Promise<Result<CredentialRecord, StoreFailure>>
  findById(input: { readonly tenantId: TenantId; readonly credentialId: CredentialId }, tx?: TransactionContext): Promise<Result<CredentialRecord | null, StoreFailure>>
  findForIdentity(input: { readonly tenantId: TenantId; readonly identityId: IdentityId; readonly methodId: MethodId }, tx?: TransactionContext): Promise<Result<CredentialRecord | null, StoreFailure>>
  replaceMaterial(input: { readonly tenantId: TenantId; readonly credentialId: CredentialId; readonly expectedVersion: number; readonly material: CredentialMaterial; readonly now: Date }, tx?: TransactionContext): Promise<Result<CredentialRecord, StoreFailure>>
  updateStatus(input: { readonly tenantId: TenantId; readonly credentialId: CredentialId; readonly expectedVersion: number; readonly status: CredentialRecord['status']; readonly now: Date }, tx?: TransactionContext): Promise<Result<CredentialRecord, StoreFailure>>
}

export interface SessionStore {
  create(input: { readonly record: SessionRecord }, tx?: TransactionContext): Promise<Result<SessionRecord, StoreFailure>>
  findById(input: { readonly tenantId: TenantId; readonly sessionId: SessionId }, tx?: TransactionContext): Promise<Result<SessionRecord | null, StoreFailure>>
  /** Matches the stable verifier identity: scheme, keyId (or empty), and persisted value. Metadata such as createdAt is not part of lookup identity. */
  findByTokenHash(input: { readonly tenantId: TenantId; readonly tokenHash: ProtectedValue }, tx?: TransactionContext): Promise<Result<SessionRecord | null, StoreFailure>>
  /** Idempotent/non-enumerating: missing sessions return ok=true, value=null. */
  revoke(input: { readonly tenantId: TenantId; readonly sessionId: SessionId; readonly now: Date }, tx?: TransactionContext): Promise<Result<SessionRecord | null, StoreFailure>>
  cleanupExpired(input: { readonly tenantId: TenantId; readonly now: Date; readonly limit?: number }, tx?: TransactionContext): Promise<Result<number, StoreFailure>>
}

export type ConsumePendingResult = 'consumed' | 'already-consumed' | 'expired' | 'attempts-exceeded' | 'version-conflict'

export type RecordFailedAttemptResult =
  | { readonly status: 'recorded'; readonly challenge: ChallengeRecord }
  | { readonly status: 'attempts-exceeded'; readonly challenge: ChallengeRecord }
  | { readonly status: 'expired'; readonly challenge: ChallengeRecord }
  | { readonly status: 'version-conflict' }

export interface ChallengeStore {
  create(input: { readonly record: ChallengeRecord }, tx?: TransactionContext): Promise<Result<ChallengeRecord, StoreFailure>>
  findById(input: { readonly tenantId: TenantId; readonly challengeId: ChallengeId }, tx?: TransactionContext): Promise<Result<ChallengeRecord | null, StoreFailure>>
  /**
   * A recorded result must acknowledge exactly one monotonic version/attempt increment
   * of the requested pending challenge. Terminal results must not fabricate a record.
   */
  recordFailedAttempt(input: { readonly tenantId: TenantId; readonly challengeId: ChallengeId; readonly expectedVersion: number; readonly now: Date; readonly reason: InternalAuthReason }, tx?: TransactionContext): Promise<Result<RecordFailedAttemptResult, StoreFailure>>
  consumePending(input: { readonly tenantId: TenantId; readonly challengeId: ChallengeId; readonly expectedVersion: number; readonly now: Date }, tx?: TransactionContext): Promise<Result<ConsumePendingResult, StoreFailure>>
  cleanupExpired(input: { readonly tenantId: TenantId; readonly now: Date; readonly limit?: number }, tx?: TransactionContext): Promise<Result<number, StoreFailure>>
}

export type DurableStores = {
  readonly accounts: AccountStore
  readonly identities: IdentityStore
  readonly credentials: CredentialStore
}

export type SessionStores = {
  readonly sessions: SessionStore
}

export type EphemeralStores = {
  /** Required only when any configured method supports begin/complete challenge flows. */
  readonly challenges?: ChallengeStore
}

export type AuthStore = {
  readonly durable: DurableStores
  readonly session: SessionStores
  readonly ephemeral?: EphemeralStores
  /** Required by current core method flows that persist auth, challenge, session, or required-effect state. */
  readonly transaction?: TransactionRunner
}
