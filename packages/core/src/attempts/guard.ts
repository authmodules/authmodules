import type { CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthFailure, InternalAuthReason, PublicAuthErrorCode } from '@authmodules/contracts/errors'
import type { AuthGuardDecision, GuardBeforeAttemptInput } from '@authmodules/contracts/guard'
import type { StableAuthEventName } from '@authmodules/contracts/observability'
import type { AuthContext, PublicData } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import { emitEvent } from '../events/emit.ts'
import { policy } from '../policy/check.ts'
import { decisionAuthContext } from '../shared/context.ts'
import { authErr, normalizeInternalReason } from '../shared/errors.ts'
import { isPublicData } from '../validation/input.ts'

const allowDecisionKeys = new Set(['allow'])
const denyDecisionKeys = new Set(['allow', 'publicCodeHint', 'reason', 'retryAfterSeconds'])
const guardFailureKeys = new Set(['component', 'details', 'reason', 'type'])
const guardFailureResultKeys = new Set(['error', 'ok'])
const guardSuccessResultKeys = new Set(['ok', 'value'])

type StartAttemptInput = GuardBeforeAttemptInput & { readonly publicData?: PublicData }

export async function acceptStart(
  config: CreateAuthConfig,
  input: StartAttemptInput
): Promise<Result<void, AuthFailure>> {
  if (!config.guard) {
    const policyResult = await policy(config, {
      kind: 'start-attempt',
      context: input.context,
      method: input.method,
      operation: input.operation,
      lookup: input.lookup,
      publicData: input.publicData
    })
    if (policyResult.ok) await emitStartedEvent(config, input)
    return policyResult
  }

  let guarded: unknown
  try {
    guarded = await config.guard.beforeAttempt(structuredClone({
      context: decisionAuthContext(input.context),
      method: input.method,
      operation: input.operation,
      lookup: input.lookup,
      challengeId: input.challengeId
    }))
  } catch {
    guarded = undefined
  }
  if (!isGuardResult(guarded)) {
    return failAttempt(config, input.context, input.method, input.operation, input.lookup, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE', input.challengeId)
  }
  if (guarded.ok === false) {
    return failAttempt(config, input.context, input.method, input.operation, input.lookup, guarded.error.reason, 'TEMPORARILY_UNAVAILABLE', input.challengeId)
  }
  if (!guarded.value.allow) {
    await afterAttempt(config, input.context, input.method, input.operation, input.lookup, false, guarded.value.reason, input.challengeId)
    return authErr(input.context, guarded.value.reason, guarded.value.publicCodeHint ?? 'RATE_LIMITED', guarded.value.retryAfterSeconds)
  }

  const policyResult = await policy(config, {
    kind: 'start-attempt',
    context: input.context,
    method: input.method,
    operation: input.operation,
    lookup: input.lookup,
    publicData: input.publicData
  })
  if (!policyResult.ok) {
    await afterAttempt(config, input.context, input.method, input.operation, input.lookup, false, policyResult.error.internalReason, input.challengeId)
  } else {
    await emitStartedEvent(config, input)
  }
  return policyResult
}

async function emitStartedEvent(config: CreateAuthConfig, input: StartAttemptInput): Promise<void> {
  const name = input.operation === 'enroll'
    ? 'auth.enroll.started'
    : input.operation === 'authenticate'
      ? 'auth.authenticate.started'
      : undefined
  if (!name) return
  await emitEvent(config, input.context, {
    name,
    methodId: input.method?.methodId,
    outcome: 'success'
  })
}

export async function afterAttempt(
  config: CreateAuthConfig,
  context: AuthContext,
  method: GuardBeforeAttemptInput['method'],
  operation: GuardBeforeAttemptInput['operation'],
  lookup: GuardBeforeAttemptInput['lookup'],
  success: boolean,
  reason?: InternalAuthReason,
  challengeId?: GuardBeforeAttemptInput['challengeId'],
  countsAsAttempt = countsAsAuthenticationFailure(reason)
): Promise<void> {
  if (config.guard && typeof config.guard.afterAttempt === 'function') {
    try {
      await config.guard.afterAttempt(structuredClone({
        context: decisionAuthContext(context),
        method,
        operation,
        lookup,
        challengeId,
        outcome: success
          ? { success: true }
          : { success: false, reason: reason ?? 'INTERNAL', countsAsAttempt }
      }))
    } catch {
      // Post-attempt guard bookkeeping cannot change an already-decided auth outcome.
    }
  }
  await emitEvent(config, context, {
    name: attemptEventName(operation, success),
    methodId: method?.methodId,
    challengeId,
    outcome: success ? 'success' : 'failure',
    attributes: success ? undefined : { reason: reason ?? 'INTERNAL' }
  })
}

function attemptEventName(operation: GuardBeforeAttemptInput['operation'], success: boolean): StableAuthEventName {
  if (operation === 'enroll') return success ? 'auth.enroll.succeeded' : 'auth.enroll.failed'
  if (operation === 'authenticate') return success ? 'auth.authenticate.succeeded' : 'auth.authenticate.failed'
  if (operation === 'begin') return success ? 'auth.challenge.started' : 'auth.challenge.failed'
  return success ? 'auth.challenge.completed' : 'auth.challenge.failed'
}

function isGuardResult(value: unknown): value is
  | { readonly ok: true; readonly value: AuthGuardDecision }
  | {
      readonly ok: false
      readonly error: {
        readonly type: 'component.failure'
        readonly component: 'guard'
        readonly reason: string
      }
    } {
  if (!isRecord(value)) return false
  if (value.ok === true) return hasOnlyKeys(value, guardSuccessResultKeys) && isGuardDecision(value.value)
  return value.ok === false && hasOnlyKeys(value, guardFailureResultKeys) && isGuardFailure(value.error)
}

function isGuardDecision(value: unknown): value is AuthGuardDecision {
  if (!isRecord(value)) return false
  if (value.allow === true) return hasOnlyKeys(value, allowDecisionKeys)
  return value.allow === false
    && hasOnlyKeys(value, denyDecisionKeys)
    && isSafeReason(value.reason)
    && (value.publicCodeHint === undefined
      || value.publicCodeHint === 'RATE_LIMITED'
      || value.publicCodeHint === 'TEMPORARILY_UNAVAILABLE')
    && (value.retryAfterSeconds === undefined
      || (typeof value.retryAfterSeconds === 'number'
        && Number.isSafeInteger(value.retryAfterSeconds)
        && value.retryAfterSeconds > 0))
}

function isGuardFailure(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, guardFailureKeys)
    && value.type === 'component.failure'
    && value.component === 'guard'
    && isSafeReason(value.reason)
    && (value.details === undefined || isPublicData(value.details))
}

function isSafeReason(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function failAttempt(
  config: CreateAuthConfig,
  context: AuthContext,
  method: GuardBeforeAttemptInput['method'],
  operation: GuardBeforeAttemptInput['operation'],
  lookup: GuardBeforeAttemptInput['lookup'],
  reason: InternalAuthReason,
  publicCode?: PublicAuthErrorCode,
  challengeId?: GuardBeforeAttemptInput['challengeId'],
  countsAsAttempt = countsAsAuthenticationFailure(reason)
): Promise<Result<never, AuthFailure>> {
  const safeReason = normalizeInternalReason(reason, 'INTERNAL')
  await afterAttempt(config, context, method, operation, lookup, false, safeReason, challengeId, countsAsAttempt)
  return authErr(context, safeReason, publicCode)
}

function countsAsAuthenticationFailure(reason?: InternalAuthReason): boolean {
  return [
    'AUTHENTICATION_FAILED',
    'CREDENTIAL_NOT_FOUND',
    'IDENTITY_BINDING_MISMATCH',
    'IDENTITY_NOT_FOUND',
    'OTP_MISMATCH',
    'PASSWORD_MISMATCH'
  ].includes(reason ?? '')
}
