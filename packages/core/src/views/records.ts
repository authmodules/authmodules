import type { AccountRecord, CredentialRecord, IdentityRecord, SessionRecord } from '@authmodules/contracts/store'
import type { AccountView, CredentialView, IdentityView, SessionView } from '@authmodules/contracts/views'

export function toAccountView(record: AccountRecord): AccountView {
  return {
    tenantId: record.tenantId,
    accountId: record.accountId,
    status: record.status,
    publicData: record.publicData ? structuredClone(record.publicData) : undefined
  }
}

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
    verifiedAt: record.verifiedAt ? new Date(record.verifiedAt.getTime()) : undefined
  }
}

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

export function toSessionView(record: SessionRecord): SessionView {
  return {
    tenantId: record.tenantId,
    sessionId: record.sessionId,
    accountId: record.accountId,
    status: record.status,
    issuedAt: new Date(record.issuedAt.getTime()),
    expiresAt: new Date(record.expiresAt.getTime()),
    revokedAt: record.revokedAt ? new Date(record.revokedAt.getTime()) : undefined
  }
}
