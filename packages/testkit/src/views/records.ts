import type { AccountRecord, CredentialRecord, IdentityRecord, SessionRecord } from '@authmodules/contracts/store'
import type { AccountView, CredentialView, IdentityView, SessionView } from '@authmodules/contracts/views'

export function toAccountView(record: AccountRecord): AccountView

export function toAccountView(record: AccountRecord): AccountView {
  return {
    tenantId: record.tenantId,
    accountId: record.accountId,
    status: record.status,
    publicData: record.publicData
  }
}

export function toIdentityView(record: IdentityRecord): IdentityView

export function toIdentityView(record: IdentityRecord): IdentityView {
  return {
    tenantId: record.tenantId,
    identityId: record.identityId,
    accountId: record.accountId,
    methodId: record.methodId,
    methodKind: record.methodKind,
    subject: record.subject,
    subjectKind: record.subjectKind,
    display: record.display,
    verifiedAt: record.verifiedAt
  }
}

export function toCredentialView(record: CredentialRecord): CredentialView

export function toCredentialView(record: CredentialRecord): CredentialView {
  return {
    tenantId: record.tenantId,
    credentialId: record.credentialId,
    accountId: record.accountId,
    identityId: record.identityId,
    methodId: record.methodId,
    methodKind: record.methodKind,
    status: record.status
  }
}

export function toSessionView(record: SessionRecord): SessionView

export function toSessionView(record: SessionRecord): SessionView {
  return {
    tenantId: record.tenantId,
    sessionId: record.sessionId,
    accountId: record.accountId,
    status: record.status,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt
  }
}
