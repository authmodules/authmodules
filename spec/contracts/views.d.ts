import type {
  AccountId,
  CredentialId,
  IdentityId,
  MethodId,
  MethodKind,
  PublicData,
  SessionId,
  Subject,
  SubjectKind,
  TenantId,
} from './primitives.js'

export type AccountView = {
  readonly tenantId: TenantId
  readonly accountId: AccountId
  readonly status: 'active' | 'disabled' | 'deleted'
  readonly publicData?: PublicData
}

export type IdentityView = {
  readonly tenantId: TenantId
  readonly identityId: IdentityId
  readonly accountId: AccountId
  readonly methodId: MethodId
  readonly methodKind: MethodKind
  readonly subject: Subject
  readonly subjectKind: SubjectKind
  readonly display?: string
  readonly verifiedAt?: Date
}

export type CredentialView = {
  readonly tenantId: TenantId
  readonly credentialId: CredentialId
  readonly accountId: AccountId
  readonly identityId: IdentityId
  readonly methodId: MethodId
  readonly methodKind: MethodKind
  readonly status: 'active' | 'disabled'
}

export type SessionView = {
  readonly tenantId: TenantId
  readonly sessionId: SessionId
  readonly accountId: AccountId
  readonly status: 'active' | 'revoked' | 'expired'
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly revokedAt?: Date
}
