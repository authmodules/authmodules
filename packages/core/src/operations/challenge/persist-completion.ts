import type { CompleteInput, CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type { MethodCompleteResult } from '@authmodules/contracts/method'
import type { MethodRef } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import type {
  AccountRecord,
  ChallengeRecord,
  ChallengeStore,
  IdentityRecord
} from '@authmodules/contracts/store'
import type { TransactionContext } from '@authmodules/contracts/transaction'
import { createSession } from '../session.ts'
import { createIdentityForClaim, resolveAccount } from '../../accounts/resolve.ts'
import { dispatchRequiredSideEffects, type PersistedOperationEffects } from '../../effects/dispatch.ts'
import { afterAttempt, failAttempt } from '../../attempts/guard.ts'
import { authErr, mapReason, storeFailure } from '../../shared/errors.ts'
import { ok } from '../../shared/result.ts'
import { identityRecordFingerprint, isConsumePendingResult } from '../../validation/store.ts'
import { challengeResultToReason } from './result.ts'

type CompletionState = {
  readonly config: CreateAuthConfig
  readonly input: CompleteInput
  readonly methodRef: MethodRef
  readonly challengeStore: ChallengeStore
  readonly challenge: ChallengeRecord
  readonly output: MethodCompleteResult
  readonly now: Date
  readonly tx?: TransactionContext
}

type PersistedCompletion = PersistedOperationEffects & {
  readonly account: AccountRecord
  readonly identity: IdentityRecord
}

export async function persistCompletion(
  state: CompletionState
): Promise<Result<PersistedCompletion, AuthFailure>> {
  const { config, input, methodRef, challengeStore, challenge, output, now, tx } = state
  const consumed = await challengeStore.consumePending({
    tenantId: input.context.tenantId,
    challengeId: challenge.challengeId,
    expectedVersion: challenge.version,
    now
  }, tx)
  if (!consumed.ok) {
    return storeFailure(input.context, consumed.error)
  }
  if (!isConsumePendingResult(consumed.value)) {
    return authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (consumed.value !== 'consumed') {
    return authErr(input.context, challengeResultToReason(consumed.value), 'CHALLENGE_FAILED')
  }

  const resolved = await resolveAccount(
    config,
    input.context,
    challenge.binding.account,
    output.proof.primaryIdentity,
    output.proof,
    now,
    tx
  )
  if (!resolved.ok) {
    await afterAttempt(config, input.context, methodRef, 'complete', challenge.lookup, false, resolved.error.internalReason, input.challengeId)
    return resolved
  }

  let identity = resolved.value.identity
  if (!identity) {
    const createdIdentity = await createIdentityForClaim(
      config,
      input.context,
      resolved.value.account.accountId,
      output.proof.primaryIdentity,
      now,
      tx
    )
    if (!createdIdentity.ok) {
      await afterAttempt(config, input.context, methodRef, 'complete', challenge.lookup, false, createdIdentity.error.internalReason, input.challengeId)
      return createdIdentity
    }
    identity = createdIdentity.value
  } else if (output.proof.primaryIdentity.verifiedAt && !identity.verifiedAt) {
    const expectedIdentity = identityRecordFingerprint({
      ...identity,
      verifiedAt: output.proof.primaryIdentity.verifiedAt,
      updatedAt: now
    })
    const verified = await config.store.durable.identities.markVerified({
      tenantId: input.context.tenantId,
      identityId: identity.identityId,
      verifiedAt: output.proof.primaryIdentity.verifiedAt,
      now
    }, tx)
    if (!verified.ok) {
      return failAttempt(config, input.context, methodRef, 'complete', challenge.lookup, verified.error.reason, mapReason(verified.error.reason), input.challengeId)
    }
    if (identityRecordFingerprint(verified.value) !== expectedIdentity) {
      return failAttempt(config, input.context, methodRef, 'complete', challenge.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE', input.challengeId)
    }
    identity = verified.value
  }

  const effects = await dispatchRequiredSideEffects(config, input.context, output.sideEffects, now, tx)
  if (!effects.ok) {
    await afterAttempt(config, input.context, methodRef, 'complete', challenge.lookup, false, effects.error.internalReason, input.challengeId)
    return effects
  }

  const session = challenge.binding.session !== undefined
    ? await createSession(config, input.context, resolved.value.account.accountId, output.proof, challenge.binding.session, now, tx)
    : ok(undefined)
  if (!session.ok) {
    await afterAttempt(config, input.context, methodRef, 'complete', challenge.lookup, false, session.error.internalReason, input.challengeId)
    return session
  }

  return ok({ account: resolved.value.account, identity, session: session.value, effects: effects.value })
}
