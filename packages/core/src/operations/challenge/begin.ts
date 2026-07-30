import type { AuthBeginResult, CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import type { ChallengeRecord } from '@authmodules/contracts/store'
import { runInStoreTransaction } from '../../execution/transaction.ts'
import {
  dispatchBestEffortSideEffects,
  dispatchRequiredSideEffects,
  emitPersistedEvents,
  mergeSideEffectResults,
  type PersistedOperationEffects
} from '../../effects/dispatch.ts'
import { acceptStart, afterAttempt, failAttempt } from '../../attempts/guard.ts'
import { executionContext, toMethodRef, validationContext } from '../../method/context.ts'
import { invokeMethodRun, invokeMethodValidation } from '../../method/invoke.ts'
import { isValidBeginOutput } from '../../method/proof.ts'
import { snapshotBeginResult } from '../../method/snapshot.ts'
import { authContextFrom, isBaseOperationInput, isPublicData } from '../../validation/input.ts'
import {
  requiredEffectsCanPersist,
  sideEffectScopes
} from '../../validation/side-effects.ts'
import { challengeRecordFingerprint } from '../../validation/store.ts'
import { authErr, mapReason } from '../../shared/errors.ts'
import { generateCoreId } from '../../shared/id.ts'
import { ok } from '../../shared/result.ts'
import { readNow } from '../../shared/time.ts'
import { beginAccountPreflight, isChallengeAccountMode } from './preflight.ts'

export async function begin(
  config: CreateAuthConfig,
  input: unknown
): Promise<Result<AuthBeginResult, AuthFailure>> {
  if (!isBaseOperationInput(input) || !isChallengeAccountMode(input.account)) {
    return authErr(authContextFrom(input), 'VALIDATION_FAILED', 'INVALID_INPUT')
  }
  const account = input.account
  const method = Object.hasOwn(config.methods, input.methodId) ? config.methods[input.methodId] : undefined
  const operation = method?.operations.begin
  const methodRef = toMethodRef(method)
  if (!method || !operation) {
    return authErr(input.context, method ? 'METHOD_OPERATION_UNSUPPORTED' : 'METHOD_NOT_CONFIGURED')
  }

  const challengeStore = config.store.ephemeral?.challenges
  if (!challengeStore) {
    return authErr(input.context, 'CHALLENGE_STORE_REQUIRED')
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
    return failAttempt(config, input.context, methodRef, 'begin', undefined, 'VALIDATION_FAILED', 'INVALID_INPUT')
  }
  if (!isPublicData(validated.value.publicData)) {
    return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT')
  }

  const preflight = await beginAccountPreflight(config, input.context, input.account, validated.value.lookup)
  if (!preflight.ok) {
    await afterAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, false, preflight.error.internalReason)
    return preflight
  }

  const start = await acceptStart(config, {
    context: input.context,
    method: methodRef,
    operation: 'begin',
    lookup: validated.value.lookup,
    publicData: validated.value.publicData
  })
  if (!start.ok) {
    return start
  }

  const challengeId = generateCoreId(config, 'challenge', input.context.tenantId, now)
  if (!challengeId) {
    return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'INTERNAL', 'INTERNAL')
  }
  const run = await invokeMethodRun(
    operation.run,
    validated.value.value,
    {
      ...executionContext(methodRef, input.context, now, validated.value.lookup),
      challenge: { challengeId }
    }
  )
  if (!run.ok) {
    return failAttempt(
      config,
      input.context,
      methodRef,
      'begin',
      validated.value.lookup,
      run.error.reason,
      run.error.safePublicCodeHint ?? mapReason(run.error.reason),
      challengeId,
      run.error.countsAsAttempt === true
    )
  }

  if (!isValidBeginOutput(run.value, now)) {
    return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT', challengeId)
  }
  if (!isPublicData(run.value.publicData)) {
    return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT', challengeId)
  }
  const output = snapshotBeginResult(run.value)
  if (!requiredEffectsCanPersist(config, output.sideEffects, true)) {
    return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'SIDE_EFFECT_FAILED', 'TEMPORARILY_UNAVAILABLE', challengeId)
  }

  const transactionScopes = [
    'challenges',
    ...sideEffectScopes(config, output.sideEffects)
  ] as const
  const persisted = await runInStoreTransaction<
    PersistedOperationEffects & { readonly completedAt: Date }
  >(config, input.context, transactionScopes, async (tx) => {
    const persistenceNow = readNow(config)
    if (!persistenceNow) {
      return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'INTERNAL', 'INTERNAL', challengeId)
    }
    if (output.expiresAt <= persistenceNow) {
      return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'CHALLENGE_EXPIRED', 'CHALLENGE_FAILED', challengeId)
    }
    const record: ChallengeRecord = {
      tenantId: input.context.tenantId,
      challengeId,
      methodId: methodRef.methodId,
      methodKind: methodRef.methodKind,
      lookup: validated.value.lookup,
      status: 'pending',
      material: output.challengeMaterial,
      binding: {
        account,
        session: input.session,
        startedByActor: input.context.actor
      },
      attempts: 0,
      maxAttempts: output.maxAttempts,
      version: 1,
      expiresAt: output.expiresAt,
      createdAt: persistenceNow,
      updatedAt: persistenceNow
    }
    const expectedChallenge = challengeRecordFingerprint(record)
    const created = await challengeStore.create({ record }, tx)
    if (!created.ok) {
      return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, created.error.reason, mapReason(created.error.reason), challengeId)
    }
    if (challengeRecordFingerprint(created.value) !== expectedChallenge) {
      return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE', challengeId)
    }

    const effects = await dispatchRequiredSideEffects(
      config,
      input.context,
      output.sideEffects,
      persistenceNow,
      tx
    )
    if (!effects.ok) {
      await afterAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, false, effects.error.internalReason, challengeId)
      return effects
    }
    const completedAt = readNow(config)
    if (!completedAt) {
      return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'INTERNAL', 'INTERNAL', challengeId)
    }
    if (output.expiresAt <= completedAt) {
      return failAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, 'CHALLENGE_EXPIRED', 'CHALLENGE_FAILED', challengeId)
    }
    return ok({ effects: effects.value, completedAt })
  })
  if (!persisted.ok) {
    if (persisted.error.internalReason === 'TRANSACTION_FAILED') {
      await afterAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, false, persisted.error.internalReason, challengeId)
    }
    return persisted
  }

  const bestEffort = await dispatchBestEffortSideEffects(
    config,
    input.context,
    output.sideEffects,
    persisted.value.completedAt
  )
  const completed = {
    ...persisted.value,
    effects: mergeSideEffectResults(
      persisted.value.effects,
      bestEffort.ok ? bestEffort.value : undefined
    )
  }
  await emitPersistedEvents(config, input.context, completed, persisted.value.completedAt)
  await afterAttempt(config, input.context, methodRef, 'begin', validated.value.lookup, true, undefined, challengeId)
  return ok({
    challengeId,
    expiresAt: output.expiresAt,
    publicData: output.publicData
  })
}
