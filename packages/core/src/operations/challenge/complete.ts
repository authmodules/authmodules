import type { AuthSuccess, CompleteInput, CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import { runInStoreTransaction } from '../../execution/transaction.ts'
import {
  dispatchBestEffortSideEffects,
  emitPersistedEvents,
  mergeSideEffectResults
} from '../../effects/dispatch.ts'
import { acceptStart, afterAttempt, failAttempt } from '../../attempts/guard.ts'
import { policy } from '../../policy/check.ts'
import { executionContext, toMethodRef, validationContext } from '../../method/context.ts'
import { snapshotMaterial } from '../../method/snapshot.ts'
import { invokeMethodRun, invokeMethodValidation } from '../../method/invoke.ts'
import { identityMatches, proofMatches } from '../../method/proof.ts'
import { snapshotCompleteResult } from '../../method/snapshot.ts'
import { authContextFrom, isAuthContext, isNonEmptyString, isPublicData } from '../../validation/input.ts'
import {
  isSideEffects,
  requiredEffectsCanPersist,
  sideEffectScopes
} from '../../validation/side-effects.ts'
import { isChallengeRecord, isRecordFailedAttemptTransition } from '../../validation/store.ts'
import { toAccountView } from '../../views/records.ts'
import { authErr, mapReason, storeFailure } from '../../shared/errors.ts'
import { ok } from '../../shared/result.ts'
import { readNow } from '../../shared/time.ts'
import { persistCompletion } from './persist-completion.ts'
import { challengeActorBindingMatches } from './preflight.ts'
import { challengeRecordFailedAttemptReason } from './result.ts'

export async function complete(
  config: CreateAuthConfig,
  input: unknown
): Promise<Result<AuthSuccess, AuthFailure>> {
  if (!isCompleteInput(input)) {
    return authErr(authContextFrom(input), 'VALIDATION_FAILED', 'INVALID_INPUT')
  }
  const challengeStore = config.store.ephemeral?.challenges
  if (!challengeStore) {
    return authErr(input.context, 'CHALLENGE_STORE_REQUIRED')
  }

  const now = readNow(config)
  if (!now) {
    return authErr(input.context, 'INTERNAL', 'INTERNAL')
  }
  const challenge = await challengeStore.findById({
    tenantId: input.context.tenantId,
    challengeId: input.challengeId
  })
  if (!challenge.ok) {
    return storeFailure(input.context, challenge.error)
  }
  if (challenge.value && (!isChallengeRecord(challenge.value)
    || challenge.value.tenantId !== input.context.tenantId
    || challenge.value.challengeId !== input.challengeId)) {
    return authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!challenge.value) {
    return authErr(input.context, 'CHALLENGE_NOT_FOUND', 'CHALLENGE_FAILED')
  }
  const challengeRecord = challenge.value
  if (challengeRecord.status === 'consumed') {
    return authErr(input.context, 'CHALLENGE_ALREADY_CONSUMED', 'CHALLENGE_FAILED')
  }
  if (challengeRecord.status === 'failed' || challengeRecord.attempts >= challengeRecord.maxAttempts) {
    return authErr(input.context, 'CHALLENGE_ATTEMPTS_EXCEEDED', 'CHALLENGE_FAILED')
  }
  if (challengeRecord.status === 'expired' || challengeRecord.expiresAt <= now) {
    return authErr(input.context, 'CHALLENGE_EXPIRED', 'CHALLENGE_FAILED')
  }
  if (!challengeActorBindingMatches(challengeRecord.binding, input.context)) {
    return authErr(input.context, 'ACCOUNT_LINKING_DENIED', 'AUTHORIZATION_FAILED')
  }

  const method = Object.hasOwn(config.methods, challengeRecord.methodId)
    ? config.methods[challengeRecord.methodId]
    : undefined
  const operation = method?.operations.complete
  const methodRef = toMethodRef(method)
  if (!method || !operation) {
    return authErr(input.context, method ? 'METHOD_OPERATION_UNSUPPORTED' : 'METHOD_NOT_CONFIGURED')
  }
  if (method.methodKind !== challengeRecord.methodKind) {
    return authErr(input.context, 'METHOD_NOT_CONFIGURED')
  }

  const validated = invokeMethodValidation(
    operation.validate,
    input.input,
    validationContext(methodRef, input.context, now)
  )
  if (!validated.ok) {
    return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT', input.challengeId)
  }
  if (!isPublicData(validated.value.publicData)) {
    return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT', input.challengeId)
  }
  if (validated.value.lookup && !identityMatches(challenge.value.lookup, validated.value.lookup)) {
    return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, 'IDENTITY_BINDING_MISMATCH', undefined, input.challengeId)
  }

  const start = await acceptStart(config, {
    context: input.context,
    method: methodRef,
    operation: 'complete',
    lookup: challenge.value.lookup ?? validated.value.lookup,
    challengeId: input.challengeId,
    publicData: validated.value.publicData
  })
  if (!start.ok) {
    return start
  }

  const run = await invokeMethodRun(
    operation.run,
    validated.value.value,
    {
      ...executionContext(methodRef, input.context, now, challenge.value.lookup ?? validated.value.lookup),
      challenge: {
        challengeId: challenge.value.challengeId,
        challengeMaterial: snapshotMaterial(challenge.value.material)
      }
    }
  )

  if (!run.ok) {
    if (run.error.countsAsAttempt) {
      const failureNow = readNow(config)
      if (!failureNow) {
        return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, 'INTERNAL', 'INTERNAL', input.challengeId)
      }
      const recorded = await challengeStore.recordFailedAttempt({
        tenantId: input.context.tenantId,
        challengeId: challenge.value.challengeId,
        expectedVersion: challenge.value.version,
        now: failureNow,
        reason: run.error.reason
      })
      if (!recorded.ok) {
        return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, recorded.error.reason, mapReason(recorded.error.reason), input.challengeId)
      }
      if (!isRecordFailedAttemptTransition(challengeRecord, recorded.value, failureNow)
        || (recorded.value.status !== 'version-conflict'
          && (recorded.value.challenge.tenantId !== input.context.tenantId
            || recorded.value.challenge.challengeId !== input.challengeId))) {
        return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE', input.challengeId)
      }
      if (recorded.value.status !== 'recorded') {
        const reason = challengeRecordFailedAttemptReason(recorded.value.status)
        return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, reason, 'CHALLENGE_FAILED', input.challengeId, true)
      }
    }
    return failAttempt(
      config,
      input.context,
      methodRef,
      'complete',
      challenge.value.lookup,
      run.error.reason,
      run.error.safePublicCodeHint ?? mapReason(run.error.reason),
      input.challengeId,
      run.error.countsAsAttempt === true
    )
  }

  if (!isPublicData(run.value.publicData) || !isSideEffects(run.value.sideEffects)) {
    return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, 'VALIDATION_FAILED', 'INVALID_INPUT', input.challengeId)
  }

  if (!proofMatches(methodRef, challenge.value.lookup ?? validated.value.lookup, run.value.proof, now)) {
    return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, 'IDENTITY_BINDING_MISMATCH', undefined, input.challengeId)
  }

  const output = snapshotCompleteResult(run.value)

  if (!requiredEffectsCanPersist(config, output.sideEffects, true)) {
    return failAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, 'SIDE_EFFECT_FAILED', 'TEMPORARILY_UNAVAILABLE', input.challengeId)
  }

  const accepted = await policy(config, { kind: 'accept-proof', context: input.context, proof: output.proof })
  if (!accepted.ok) {
    await afterAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, false, accepted.error.internalReason, input.challengeId)
    return accepted
  }

  const transactionScopes = [
    'accounts',
    'identities',
    'challenges',
    ...(challengeRecord.binding.session !== undefined ? ['sessions'] : []),
    ...sideEffectScopes(config, output.sideEffects)
  ] as const
  const persisted = await runInStoreTransaction(config, input.context, transactionScopes, async (tx) => {
    const persistenceNow = readNow(config)
    if (!persistenceNow) {
      return failAttempt(
        config,
        input.context,
        methodRef,
        'complete',
        challengeRecord.lookup,
        'INTERNAL',
        'INTERNAL',
        input.challengeId
      )
    }
    if (challengeRecord.expiresAt <= persistenceNow
      || !proofMatches(
        methodRef,
        challengeRecord.lookup ?? validated.value.lookup,
        output.proof,
        persistenceNow
      )) {
      return failAttempt(
        config,
        input.context,
        methodRef,
        'complete',
        challengeRecord.lookup,
        'CHALLENGE_EXPIRED',
        'CHALLENGE_FAILED',
        input.challengeId
      )
    }
    const completion = await persistCompletion({
      config,
      input,
      methodRef,
      challengeStore,
      challenge: challengeRecord,
      output,
      now: persistenceNow,
      tx
    })
    if (!completion.ok) return completion
    const completedAt = readNow(config)
    if (!completedAt) {
      return failAttempt(
        config,
        input.context,
        methodRef,
        'complete',
        challengeRecord.lookup,
        'INTERNAL',
        'INTERNAL',
        input.challengeId
      )
    }
    if (challengeRecord.expiresAt <= completedAt
      || !proofMatches(
        methodRef,
        challengeRecord.lookup ?? validated.value.lookup,
        output.proof,
        completedAt
      )) {
      return failAttempt(
        config,
        input.context,
        methodRef,
        'complete',
        challengeRecord.lookup,
        'CHALLENGE_EXPIRED',
        'CHALLENGE_FAILED',
        input.challengeId
      )
    }
    return ok({ completion: completion.value, completedAt })
  })
  if (!persisted.ok) {
    if (persisted.error.internalReason === 'TRANSACTION_FAILED') {
      await afterAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, false, persisted.error.internalReason, input.challengeId)
    }
    return persisted
  }

  const { completion, completedAt } = persisted.value
  const bestEffort = await dispatchBestEffortSideEffects(
    config,
    input.context,
    output.sideEffects,
    completedAt
  )
  const completed = {
    ...completion,
    effects: mergeSideEffectResults(
      completion.effects,
      bestEffort.ok ? bestEffort.value : undefined
    )
  }
  await emitPersistedEvents(config, input.context, completed, completedAt)
  await afterAttempt(config, input.context, methodRef, 'complete', challenge.value.lookup, true, undefined, input.challengeId)
  return ok({
    account: toAccountView(completed.account),
    proof: output.proof,
    session: completed.session?.session,
    token: completed.session?.token,
    publicData: output.publicData
  })
}

function isCompleteInput(input: unknown): input is CompleteInput {
  return isRecord(input)
    && isAuthContext(input.context)
    && isNonEmptyString(input.challengeId)
    && 'input' in input
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
