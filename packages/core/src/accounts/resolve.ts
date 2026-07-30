import type { CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type {
  AccountId,
  AccountResolutionMode,
  AuthContext,
  AuthProof,
  IdentityClaim,
  IdentityLookup
} from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import type { AccountRecord, IdentityRecord } from '@authmodules/contracts/store'
import type { TransactionContext } from '@authmodules/contracts/transaction'
import { policy } from '../policy/check.ts'
import {
  accountRecordFingerprint,
  identityRecordFingerprint,
  isAccountRecord,
  isIdentityRecord
} from '../validation/store.ts'
import { authErr, storeFailure } from '../shared/errors.ts'
import { generateCoreId } from '../shared/id.ts'
import { ok } from '../shared/result.ts'

export type ResolvedAccount = {
  readonly account: AccountRecord
  readonly identity?: IdentityRecord
}

export async function resolveAccount(
  config: CreateAuthConfig,
  context: AuthContext,
  mode: AccountResolutionMode,
  identity: IdentityClaim,
  proof: AuthProof | undefined,
  now: Date,
  tx?: TransactionContext
): Promise<Result<ResolvedAccount, AuthFailure>> {
  const decision = await policy(config, {
    kind: 'resolve-account',
    context,
    proof,
    identity,
    lookup: identity,
    mode
  })
  if (!decision.ok) {
    return decision
  }

  const existingIdentity = await findIdentity(config, context, identity, tx)
  if (!existingIdentity.ok) {
    return existingIdentity
  }

  if (mode.mode === 'create-new-account' && existingIdentity.value) {
    return authErr(context, 'IDENTITY_CONFLICT', 'CONFLICT')
  }

  if (mode.mode === 'require-existing-identity' && !existingIdentity.value) {
    return authErr(context, 'AUTHENTICATION_FAILED', 'AUTHENTICATION_FAILED')
  }

  if (mode.mode === 'link-to-actor-account') {
    if (context.actor?.type !== 'account') {
      return authErr(context, 'ACCOUNT_LINKING_DENIED', 'AUTHORIZATION_FAILED')
    }
    if (existingIdentity.value && existingIdentity.value.accountId !== context.actor.accountId) {
      return authErr(context, 'ACCOUNT_LINKING_DENIED', 'AUTHORIZATION_FAILED')
    }
    const actorAccount = await config.store.durable.accounts.findById({
      tenantId: context.tenantId,
      accountId: context.actor.accountId
    }, tx)
    if (!actorAccount.ok) {
      return storeFailure(context, actorAccount.error)
    }
    if (actorAccount.value && (!isAccountRecord(actorAccount.value)
      || actorAccount.value.tenantId !== context.tenantId
      || actorAccount.value.accountId !== context.actor.accountId)) {
      return authErr(context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
    }
    if (!actorAccount.value || actorAccount.value.status !== 'active') {
      return authErr(context, 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_UNAVAILABLE')
    }
    return ok({ account: actorAccount.value, identity: existingIdentity.value ?? undefined })
  }

  if (existingIdentity.value) {
    const account = await config.store.durable.accounts.findById({
      tenantId: context.tenantId,
      accountId: existingIdentity.value.accountId
    }, tx)
    if (!account.ok) {
      return storeFailure(context, account.error)
    }
    if (account.value && (!isAccountRecord(account.value)
      || account.value.tenantId !== context.tenantId
      || account.value.accountId !== existingIdentity.value.accountId)) {
      return authErr(context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
    }
    if (!account.value || account.value.status !== 'active') {
      return authErr(context, 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_UNAVAILABLE')
    }
    return ok({ account: account.value, identity: existingIdentity.value })
  }

  const accountId = generateCoreId(config, 'account', context.tenantId, now)
  if (!accountId) {
    return authErr(context, 'INTERNAL', 'INTERNAL')
  }
  const accountRecord: AccountRecord = {
    tenantId: context.tenantId,
    accountId,
    status: 'active',
    createdAt: now,
    updatedAt: now
  }
  const expectedAccount = accountRecordFingerprint(accountRecord)
  const created = await config.store.durable.accounts.create({ record: accountRecord }, tx)
  if (!created.ok) {
    return storeFailure(context, created.error)
  }
  if (accountRecordFingerprint(created.value) !== expectedAccount) {
    return authErr(context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  return ok({ account: created.value, identity: undefined })
}

export async function createIdentityForClaim(
  config: CreateAuthConfig,
  context: AuthContext,
  accountId: AccountId,
  identity: IdentityClaim,
  now: Date,
  tx?: TransactionContext
): Promise<Result<IdentityRecord, AuthFailure>> {
  const identityId = generateCoreId(config, 'identity', context.tenantId, now)
  if (!identityId) {
    return authErr(context, 'INTERNAL', 'INTERNAL')
  }
  const identityRecord: IdentityRecord = {
    tenantId: context.tenantId,
    identityId,
    accountId,
    methodId: identity.methodId,
    methodKind: identity.methodKind,
    subject: identity.subject,
    subjectKind: identity.subjectKind,
    display: identity.display,
    verifiedAt: identity.verifiedAt,
    createdAt: now,
    updatedAt: now
  }
  const expectedIdentity = identityRecordFingerprint(identityRecord)
  const created = await config.store.durable.identities.create({ record: identityRecord }, tx)
  if (!created.ok) {
    return storeFailure(context, created.error)
  }
  if (identityRecordFingerprint(created.value) !== expectedIdentity) {
    return authErr(context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  return ok(created.value)
}

export async function findIdentity(
  config: CreateAuthConfig,
  context: AuthContext,
  lookup?: IdentityLookup,
  tx?: TransactionContext
): Promise<Result<IdentityRecord | null, AuthFailure>> {
  if (!lookup) {
    return ok(null)
  }
  const result = await config.store.durable.identities.findBySubject({
    tenantId: context.tenantId,
    methodId: lookup.methodId,
    subject: lookup.subject
  }, tx)
  if (!result.ok) {
    return storeFailure(context, result.error)
  }
  if (result.value && (!isIdentityRecord(result.value)
    || result.value.tenantId !== context.tenantId
    || result.value.methodId !== lookup.methodId
    || result.value.methodKind !== lookup.methodKind
    || result.value.subject !== lookup.subject
    || result.value.subjectKind !== lookup.subjectKind)) {
    return authErr(context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  return ok(result.value)
}

export function identityKeyForProof(identity: IdentityClaim): string {
  return `${identity.methodId}\u0000${identity.subject}`
}
