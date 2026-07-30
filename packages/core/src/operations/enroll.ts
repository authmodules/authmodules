import type { CreateAuthConfig, EnrollInput, EnrollSuccess } from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type { MethodEnrollResult, ValidatedMethodInput } from '@authmodules/contracts/method'
import type { MethodRef } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import type { AccountRecord, CredentialRecord, IdentityRecord } from '@authmodules/contracts/store'
import type { TransactionContext } from '@authmodules/contracts/transaction'
import { isEnrollmentAccountMode } from './challenge.ts'
import { createSession } from './session.ts'
import { resolveAccount } from '../accounts/resolve.ts'
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
import { identityMatches, identityMatchesMethod, proofMatches } from '../method/proof.ts'
import { snapshotEnrollResult } from '../method/snapshot.ts'
import { authContextFrom, isBaseOperationInput, isPublicData } from '../validation/input.ts'
import { isIdentityClaim, isMethodMaterial } from '../validation/method-data.ts'
import {
  isSideEffects,
  requiredEffectsCanPersist,
  sideEffectScopes
} from '../validation/side-effects.ts'
import {
  credentialRecordFingerprint,
  identityRecordFingerprint,
  isCredentialRecord
} from '../validation/store.ts'
import { toAccountView, toCredentialView, toIdentityView } from '../views/records.ts'
import { authErr, mapReason } from '../shared/errors.ts'
import { generateCoreId } from '../shared/id.ts'
import { ok } from '../shared/result.ts'
import { readNow } from '../shared/time.ts'

type EnrollmentState = {
  readonly config: CreateAuthConfig
  readonly input: EnrollInput
  readonly methodRef: MethodRef
  readonly validated: ValidatedMethodInput<unknown>
  readonly output: MethodEnrollResult
  readonly now: Date
  readonly tx?: TransactionContext
}

type PersistedEnrollment = PersistedOperationEffects & {
  readonly account: AccountRecord
  readonly identity: IdentityRecord
  readonly credential?: CredentialRecord
}

export async function enroll(
  config: CreateAuthConfig,
  input: unknown
): Promise<Result<EnrollSuccess, AuthFailure>> {
  if (!isBaseOperationInput(input) || !isEnrollmentAccountMode(input.account)) {
    return authErr(authContextFrom(input), 'VALIDATION_FAILED', 'INVALID_INPUT')
  }
  const enrollmentInput: EnrollInput = { ...input, account: input.account }
  const method = Object.hasOwn(config.methods, input.methodId) ? config.methods[input.methodId] : undefined
  const operation = method?.operations.enroll
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
    return failAttempt(config, input.context, methodRef, 'enroll', undefined, 'VALIDATION_FAILED', 'INVALID_INPUT')
  }
  if (!isPublicData(validated.value.publicData)) {
    return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT')
  }

  const start = await acceptStart(config, {
    context: input.context,
    method: methodRef,
    operation: 'enroll',
    lookup: validated.value.lookup,
    publicData: validated.value.publicData
  })
  if (!start.ok) {
    return start
  }

  const run = await invokeMethodRun(
    operation.run,
    validated.value.value,
    executionContext(methodRef, input.context, now, validated.value.lookup)
  )
  if (!run.ok) {
    return failAttempt(
      config,
      input.context,
      methodRef,
      'enroll',
      validated.value.lookup,
      run.error.reason,
      run.error.safePublicCodeHint ?? mapReason(run.error.reason),
      undefined,
      run.error.countsAsAttempt === true
    )
  }

  if (!isIdentityClaim(run.value.identity, now)
    || !isMethodMaterial(run.value.credentialMaterial)
    || !isSideEffects(run.value.sideEffects)) {
    return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT')
  }

  if (!identityMatchesMethod(methodRef, run.value.identity)
    || !identityMatches(validated.value.lookup, run.value.identity)) {
    return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'IDENTITY_BINDING_MISMATCH')
  }

  if (!isPublicData(run.value.publicData)) {
    return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT')
  }

  if (run.value.proof && (
    !proofMatches(methodRef, validated.value.lookup, run.value.proof, now)
    || !identityMatches(run.value.identity, run.value.proof.primaryIdentity)
  )) {
    return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'IDENTITY_BINDING_MISMATCH')
  }

  const output = snapshotEnrollResult(run.value)
  if (!requiredEffectsCanPersist(config, output.sideEffects, true)) {
    return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'SIDE_EFFECT_FAILED', 'TEMPORARILY_UNAVAILABLE')
  }

  const accepted = await policy(config, {
    kind: 'accept-enrollment',
    context: input.context,
    method: methodRef,
    identity: output.identity,
    hasCredentialMaterial: Boolean(output.credentialMaterial),
    publicData: output.publicData
  })
  if (!accepted.ok) {
    await afterAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, false, accepted.error.internalReason)
    return accepted
  }

  const transactionScopes = [
    'accounts',
    'identities',
    ...(output.credentialMaterial ? ['credentials'] : []),
    ...(output.proof && input.session !== undefined ? ['sessions'] : []),
    ...sideEffectScopes(config, output.sideEffects)
  ] as const
  const persisted = await runInStoreTransaction(config, input.context, transactionScopes, async (tx) => {
    const persistenceNow = readNow(config)
    if (!persistenceNow) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'INTERNAL', 'INTERNAL')
    }
    if (output.proof && !proofMatches(methodRef, validated.value.lookup, output.proof, persistenceNow)) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'IDENTITY_BINDING_MISMATCH')
    }
    const enrollment = await persistEnrollment({
      config,
      input: enrollmentInput,
      methodRef,
      validated: validated.value,
      output,
      now: persistenceNow,
      tx
    })
    if (!enrollment.ok) return enrollment
    const completedAt = readNow(config)
    if (!completedAt) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'INTERNAL', 'INTERNAL')
    }
    if (output.proof && !proofMatches(methodRef, validated.value.lookup, output.proof, completedAt)) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, 'IDENTITY_BINDING_MISMATCH')
    }
    return ok({ enrollment: enrollment.value, completedAt })
  })
  if (!persisted.ok) {
    if (persisted.error.internalReason === 'TRANSACTION_FAILED') {
      await afterAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, false, persisted.error.internalReason)
    }
    return persisted
  }

  const { enrollment, completedAt } = persisted.value
  const bestEffort = await dispatchBestEffortSideEffects(
    config,
    input.context,
    output.sideEffects,
    completedAt
  )
  const completed = {
    ...enrollment,
    effects: mergeSideEffectResults(
      enrollment.effects,
      bestEffort.ok ? bestEffort.value : undefined
    )
  }
  await emitPersistedEvents(config, input.context, completed, completedAt)
  await afterAttempt(config, input.context, methodRef, 'enroll', validated.value.lookup, true)
  return ok({
    account: toAccountView(completed.account),
    identity: toIdentityView(completed.identity),
    credential: completed.credential ? toCredentialView(completed.credential) : undefined,
    proof: output.proof,
    session: completed.session?.session,
    token: completed.session?.token,
    publicData: output.publicData
  })
}

async function persistEnrollment(state: EnrollmentState): Promise<Result<PersistedEnrollment, AuthFailure>> {
  const { config, input, methodRef, validated, output, now, tx } = state
  const resolved = await resolveAccount(config, input.context, input.account, output.identity, output.proof, now, tx)
  if (!resolved.ok) {
    await afterAttempt(config, input.context, methodRef, 'enroll', validated.lookup, false, resolved.error.internalReason)
    return resolved
  }

  let identity = resolved.value.identity
  if (!identity) {
    const identityId = generateCoreId(config, 'identity', input.context.tenantId, now)
    if (!identityId) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.lookup, 'INTERNAL', 'INTERNAL')
    }
    const identityRecord = {
      tenantId: input.context.tenantId,
      identityId,
      accountId: resolved.value.account.accountId,
      methodId: output.identity.methodId,
      methodKind: output.identity.methodKind,
      subject: output.identity.subject,
      subjectKind: output.identity.subjectKind,
      display: output.identity.display,
      verifiedAt: output.identity.verifiedAt,
      createdAt: now,
      updatedAt: now
    }
    const expectedIdentity = identityRecordFingerprint(identityRecord)
    const created = await config.store.durable.identities.create({ record: identityRecord }, tx)
    if (!created.ok) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.lookup, created.error.reason, mapReason(created.error.reason))
    }
    if (identityRecordFingerprint(created.value) !== expectedIdentity) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
    }
    identity = created.value
  }

  let credential: CredentialRecord | undefined
  if (output.credentialMaterial) {
    const existingCredential = await config.store.durable.credentials.findForIdentity({
      tenantId: input.context.tenantId,
      identityId: identity.identityId,
      methodId: methodRef.methodId
    }, tx)
    if (!existingCredential.ok) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.lookup, existingCredential.error.reason, mapReason(existingCredential.error.reason))
    }
    if (existingCredential.value && (!isCredentialRecord(existingCredential.value)
      || existingCredential.value.tenantId !== input.context.tenantId
      || existingCredential.value.identityId !== identity.identityId
      || existingCredential.value.methodId !== methodRef.methodId
      || existingCredential.value.accountId !== resolved.value.account.accountId)) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
    }
    if (existingCredential.value) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.lookup, 'IDENTITY_CONFLICT', 'CONFLICT')
    }

    const credentialId = generateCoreId(config, 'credential', input.context.tenantId, now)
    if (!credentialId) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.lookup, 'INTERNAL', 'INTERNAL')
    }
    const credentialRecord: CredentialRecord = {
      tenantId: input.context.tenantId,
      credentialId,
      accountId: resolved.value.account.accountId,
      identityId: identity.identityId,
      methodId: methodRef.methodId,
      methodKind: methodRef.methodKind,
      status: 'active',
      material: output.credentialMaterial,
      version: 1,
      createdAt: now,
      updatedAt: now
    }
    const expectedCredential = credentialRecordFingerprint(credentialRecord)
    const created = await config.store.durable.credentials.create({ record: credentialRecord }, tx)
    if (!created.ok) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.lookup, created.error.reason, mapReason(created.error.reason))
    }
    if (credentialRecordFingerprint(created.value) !== expectedCredential) {
      return failAttempt(config, input.context, methodRef, 'enroll', validated.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
    }
    credential = created.value
  }

  const effects = await dispatchRequiredSideEffects(config, input.context, output.sideEffects, now, tx)
  if (!effects.ok) {
    await afterAttempt(config, input.context, methodRef, 'enroll', validated.lookup, false, effects.error.internalReason)
    return effects
  }

  const session = output.proof && input.session !== undefined
    ? await createSession(config, input.context, resolved.value.account.accountId, output.proof, input.session, now, tx)
    : ok(undefined)
  if (!session.ok) {
    await afterAttempt(config, input.context, methodRef, 'enroll', validated.lookup, false, session.error.internalReason)
    return session
  }

  return ok({
    account: resolved.value.account,
    identity,
    credential,
    session: session.value,
    effects: effects.value
  })
}
