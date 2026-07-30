import type { CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type {
  AccountResolutionMode,
  AuthContext,
  ChallengeBinding,
  EnrollmentAccountResolutionMode,
  IdentityLookup
} from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import { findIdentity } from '../../accounts/resolve.ts'
import { isAccountRecord } from '../../validation/store.ts'
import { authErr, storeFailure } from '../../shared/errors.ts'
import { ok } from '../../shared/result.ts'

export function isEnrollmentAccountMode(mode: unknown): mode is EnrollmentAccountResolutionMode {
  return isRecord(mode)
    && hasOnlyKeys(mode, new Set(['mode']))
    && (mode.mode === 'create-new-account' || mode.mode === 'link-to-actor-account')
}

export function isChallengeAccountMode(mode: unknown): mode is AccountResolutionMode {
  return isRecord(mode)
    && hasOnlyKeys(mode, new Set(['mode']))
    && (mode.mode === 'create-new-account'
    || mode?.mode === 'require-existing-identity'
    || mode?.mode === 'create-account-if-identity-missing'
    || mode?.mode === 'link-to-actor-account')
}

export function challengeActorBindingMatches(binding: ChallengeBinding, context: AuthContext): boolean {
  if (binding?.account?.mode !== 'link-to-actor-account') return true
  return binding.startedByActor?.type === 'account'
    && context.actor?.type === 'account'
    && binding.startedByActor.accountId === context.actor.accountId
}

export async function beginAccountPreflight(
  config: CreateAuthConfig,
  context: AuthContext,
  mode: AccountResolutionMode,
  lookup?: IdentityLookup
): Promise<Result<void, AuthFailure>> {
  if (!lookup) {
    return ok(undefined)
  }

  const existingIdentity = await findIdentity(config, context, lookup)
  if (!existingIdentity.ok) {
    return existingIdentity
  }

  if (mode.mode === 'require-existing-identity') {
    return existingIdentity.value ? ok(undefined) : authErr(context, 'AUTHENTICATION_FAILED', 'CHALLENGE_FAILED')
  }

  if (mode.mode === 'create-new-account') {
    return existingIdentity.value ? authErr(context, 'IDENTITY_CONFLICT', 'CONFLICT') : ok(undefined)
  }

  if (mode.mode === 'create-account-if-identity-missing') {
    return ok(undefined)
  }

  if (mode.mode === 'link-to-actor-account') {
    if (context.actor?.type !== 'account') {
      return authErr(context, 'ACCOUNT_LINKING_DENIED', 'AUTHORIZATION_FAILED')
    }
    if (existingIdentity.value && existingIdentity.value.accountId !== context.actor.accountId) {
      return authErr(context, 'IDENTITY_CONFLICT', 'CONFLICT')
    }
    const actorAccount = await config.store.durable.accounts.findById({
      tenantId: context.tenantId,
      accountId: context.actor.accountId
    })
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
  }

  return ok(undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
