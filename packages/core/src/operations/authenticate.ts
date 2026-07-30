import type { AuthenticateInput, AuthSuccess, CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type { MethodAuthenticateResult, ValidatedMethodInput } from '@authmodules/contracts/method'
import type { MethodRef } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import type { AccountRecord, CredentialRecord, IdentityRecord } from '@authmodules/contracts/store'
import type { TransactionContext } from '@authmodules/contracts/transaction'
import { createSession } from './session.ts'
import { findIdentity } from '../accounts/resolve.ts'
import { runInStoreTransaction } from '../execution/transaction.ts'
import {
  dispatchBestEffortSideEffects,
  dispatchRequiredSideEffects,
  emitPersistedEvents,
  mergeSideEffectResults,
  type PersistedOperationEffects
} from '../effects/dispatch.ts'
import { acceptStart, afterAttempt, failAttempt } from '../attempts/guard.ts'
import { policy } from '../policy/check.ts'
import { executionContext, toMethodRef, validationContext } from '../method/context.ts'
import { invokeMethodRun, invokeMethodValidation } from '../method/invoke.ts'
import { proofMatches } from '../method/proof.ts'
import { snapshotAuthenticateResult } from '../method/snapshot.ts'
import { authContextFrom, isBaseOperationInput, isPublicData } from '../validation/input.ts'
import { isMethodMaterial } from '../validation/method-data.ts'
import {
  isSideEffects,
  requiredEffectsCanPersist,
  sideEffectScopes
} from '../validation/side-effects.ts'
import {
  credentialRecordFingerprint,
  isAccountRecord,
  isCredentialRecord
} from '../validation/store.ts'
import { toAccountView } from '../views/records.ts'
import { authErr, mapReason } from '../shared/errors.ts'
import { ok } from '../shared/result.ts'
import { readNow } from '../shared/time.ts'

type AuthenticationState = {
  readonly config: CreateAuthConfig
  readonly input: AuthenticateInput
  readonly methodRef: MethodRef
  readonly validated: ValidatedMethodInput<unknown>
  readonly output: MethodAuthenticateResult
  readonly identity: IdentityRecord
  readonly credential: CredentialRecord
  readonly now: Date
  readonly tx?: TransactionContext
}

type PersistedAuthentication = PersistedOperationEffects & {
  readonly account: AccountRecord
}

export async function authenticate(
  config: CreateAuthConfig,
  input: unknown
): Promise<Result<AuthSuccess, AuthFailure>> {
  if (!isBaseOperationInput(input)) {
    return authErr(authContextFrom(input), 'VALIDATION_FAILED', 'INVALID_INPUT')
  }
  const method = Object.hasOwn(config.methods, input.methodId) ? config.methods[input.methodId] : undefined
  const operation = method?.operations.authenticate
  const methodRef = toMethodRef(method)
  if (!method || !operation) {
    return authErr(input.context, method ? 'METHOD_OPERATION_UNSUPPORTED' : 'METHOD_NOT_CONFIGURED')
  }
  const now = readNow(config)
  if (!now) {
    return authErr(input.context, 'INTERNAL', 'INTERNAL')
  }

  const validated = invokeMethodValidation(
    operation.validate,
    input.input,
    validationContext(methodRef, input.context, now)
  )
  if (!validated.ok) {
    return failAttempt(config, input.context, methodRef, 'authenticate', undefined, 'VALIDATION_FAILED', 'INVALID_INPUT')
  }
  if (!isPublicData(validated.value.publicData)) {
    return failAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT')
  }

  const start = await acceptStart(config, {
    context: input.context,
    method: methodRef,
    operation: 'authenticate',
    lookup: validated.value.lookup,
    publicData: validated.value.publicData
  })
  if (!start.ok) {
    return start
  }

  const identity = await findIdentity(config, input.context, validated.value.lookup)
  if (!identity.ok) {
    await afterAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, false, identity.error.internalReason)
    return identity
  }
  const identityRecord = identity.value ?? undefined

  let credentialRecord: CredentialRecord | undefined
  if (identityRecord) {
    const credential = await config.store.durable.credentials.findForIdentity({
      tenantId: input.context.tenantId,
      identityId: identityRecord.identityId,
      methodId: methodRef.methodId
    })
    if (!credential.ok) {
      return failAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, credential.error.reason, mapReason(credential.error.reason))
    }
    if (credential.value && (!isCredentialRecord(credential.value)
      || credential.value.tenantId !== input.context.tenantId
      || credential.value.identityId !== identityRecord.identityId
      || credential.value.accountId !== identityRecord.accountId
      || credential.value.methodId !== methodRef.methodId
      || credential.value.methodKind !== methodRef.methodKind)) {
      return failAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
    }
    if (credential.value?.status === 'active') {
      credentialRecord = credential.value
    }
  }

  const run = await invokeMethodRun(
    operation.run,
    validated.value.value,
    executionContext(
      methodRef,
      input.context,
      now,
      validated.value.lookup,
      identityRecord
        ? {
            identityId: identityRecord.identityId,
            credentialId: credentialRecord?.credentialId,
            credentialMaterial: credentialRecord?.material
          }
        : undefined
    )
  )
  if (!run.ok) {
    return failAttempt(
      config,
      input.context,
      methodRef,
      'authenticate',
      validated.value.lookup,
      run.error.reason,
      run.error.safePublicCodeHint ?? mapReason(run.error.reason),
      undefined,
      run.error.countsAsAttempt === true
    )
  }

  if (!identityRecord || !credentialRecord) {
    return failAttempt(
      config,
      input.context,
      methodRef,
      'authenticate',
      validated.value.lookup,
      'AUTHENTICATION_FAILED',
      'AUTHENTICATION_FAILED',
      undefined,
      true
    )
  }

  if (!isPublicData(run.value.publicData)
    || !isMethodMaterial(run.value.credentialMaterial)
    || !isSideEffects(run.value.sideEffects)) {
    return failAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT')
  }

  if (!proofMatches(methodRef, validated.value.lookup, run.value.proof, now)) {
    return failAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, 'IDENTITY_BINDING_MISMATCH')
  }

  const output = snapshotAuthenticateResult(run.value)

  if (!requiredEffectsCanPersist(
    config,
    output.sideEffects,
    Boolean(output.credentialMaterial || input.session !== undefined)
  )) {
    return failAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, 'SIDE_EFFECT_FAILED', 'TEMPORARILY_UNAVAILABLE')
  }

  const accepted = await policy(config, { kind: 'accept-proof', context: input.context, proof: output.proof })
  if (!accepted.ok) {
    await afterAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, false, accepted.error.internalReason)
    return accepted
  }

  const transactionScopes = [
    'accounts',
    'credentials',
    ...(input.session !== undefined ? ['sessions'] : []),
    ...sideEffectScopes(config, output.sideEffects)
  ] as const
  const persisted = await runInStoreTransaction(config, input.context, transactionScopes, async (tx) => {
    const persistenceNow = readNow(config)
    if (!persistenceNow) {
      return failAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, 'INTERNAL', 'INTERNAL')
    }
    if (!proofMatches(methodRef, validated.value.lookup, output.proof, persistenceNow)) {
      return failAttempt(
        config,
        input.context,
        methodRef,
        'authenticate',
        validated.value.lookup,
        'AUTHENTICATION_FAILED',
        'AUTHENTICATION_FAILED',
        undefined,
        true
      )
    }
    const authentication = await persistAuthentication({
      config,
      input,
      methodRef,
      validated: validated.value,
      output,
      identity: identityRecord,
      credential: credentialRecord,
      now: persistenceNow,
      tx
    })
    if (!authentication.ok) return authentication
    const completedAt = readNow(config)
    if (!completedAt) {
      return failAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, 'INTERNAL', 'INTERNAL')
    }
    if (!proofMatches(methodRef, validated.value.lookup, output.proof, completedAt)) {
      return failAttempt(
        config,
        input.context,
        methodRef,
        'authenticate',
        validated.value.lookup,
        'AUTHENTICATION_FAILED',
        'AUTHENTICATION_FAILED',
        undefined,
        true
      )
    }
    return ok({ authentication: authentication.value, completedAt })
  })
  if (!persisted.ok) {
    if (persisted.error.internalReason === 'TRANSACTION_FAILED') {
      await afterAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, false, persisted.error.internalReason)
    }
    return persisted
  }

  const { authentication, completedAt } = persisted.value
  const bestEffort = await dispatchBestEffortSideEffects(
    config,
    input.context,
    output.sideEffects,
    completedAt
  )
  const completed = {
    ...authentication,
    effects: mergeSideEffectResults(
      authentication.effects,
      bestEffort.ok ? bestEffort.value : undefined
    )
  }
  await emitPersistedEvents(config, input.context, completed, completedAt)
  await afterAttempt(config, input.context, methodRef, 'authenticate', validated.value.lookup, true)
  return ok({
    account: toAccountView(completed.account),
    proof: output.proof,
    session: completed.session?.session,
    token: completed.session?.token,
    publicData: output.publicData
  })
}

async function persistAuthentication(
  state: AuthenticationState
): Promise<Result<PersistedAuthentication, AuthFailure>> {
  const { config, input, methodRef, validated, output, identity, credential, now, tx } = state
  const currentCredential = await config.store.durable.credentials.findForIdentity({
    tenantId: input.context.tenantId,
    identityId: identity.identityId,
    methodId: methodRef.methodId
  }, tx)
  if (!currentCredential.ok) {
    return failAttempt(
      config,
      input.context,
      methodRef,
      'authenticate',
      validated.lookup,
      currentCredential.error.reason,
      mapReason(currentCredential.error.reason)
    )
  }
  if (!currentCredential.value
    || !isCredentialRecord(currentCredential.value)
    || currentCredential.value.tenantId !== input.context.tenantId
    || currentCredential.value.credentialId !== credential.credentialId
    || currentCredential.value.accountId !== identity.accountId
    || currentCredential.value.identityId !== identity.identityId
    || currentCredential.value.methodId !== methodRef.methodId
    || currentCredential.value.methodKind !== methodRef.methodKind
    || currentCredential.value.status !== 'active'
    || currentCredential.value.version !== credential.version) {
    return failAttempt(
      config,
      input.context,
      methodRef,
      'authenticate',
      validated.lookup,
      'AUTHENTICATION_FAILED',
      'AUTHENTICATION_FAILED',
      undefined,
      true
    )
  }
  if (output.credentialMaterial) {
    const expectedCredential = credentialRecordFingerprint({
      ...currentCredential.value,
      material: output.credentialMaterial,
      version: currentCredential.value.version + 1,
      updatedAt: now
    })
    const replaced = await config.store.durable.credentials.replaceMaterial({
      tenantId: input.context.tenantId,
      credentialId: currentCredential.value.credentialId,
      expectedVersion: currentCredential.value.version,
      material: output.credentialMaterial,
      now
    }, tx)
    if (!replaced.ok) {
      return failAttempt(config, input.context, methodRef, 'authenticate', validated.lookup, replaced.error.reason, mapReason(replaced.error.reason))
    }
    if (credentialRecordFingerprint(replaced.value) !== expectedCredential) {
      return failAttempt(config, input.context, methodRef, 'authenticate', validated.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
    }
  }

  const account = await config.store.durable.accounts.findById({
    tenantId: input.context.tenantId,
    accountId: identity.accountId
  }, tx)
  if (!account.ok) {
    return failAttempt(config, input.context, methodRef, 'authenticate', validated.lookup, account.error.reason, mapReason(account.error.reason))
  }
  if (account.value && (!isAccountRecord(account.value)
    || account.value.tenantId !== input.context.tenantId
    || account.value.accountId !== identity.accountId)) {
    return failAttempt(config, input.context, methodRef, 'authenticate', validated.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!account.value || account.value.status !== 'active') {
    return failAttempt(config, input.context, methodRef, 'authenticate', validated.lookup, 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_UNAVAILABLE')
  }

  const effects = await dispatchRequiredSideEffects(config, input.context, output.sideEffects, now, tx)
  if (!effects.ok) {
    await afterAttempt(config, input.context, methodRef, 'authenticate', validated.lookup, false, effects.error.internalReason)
    return effects
  }

  const session = input.session !== undefined
    ? await createSession(config, input.context, account.value.accountId, output.proof, input.session, now, tx)
    : ok(undefined)
  if (!session.ok) {
    await afterAttempt(config, input.context, methodRef, 'authenticate', validated.lookup, false, session.error.internalReason)
    return session
  }

  return ok({ account: account.value, session: session.value, effects: effects.value })
}
