import type { GuardAfterAttemptInput, GuardBeforeAttemptInput } from '@authmodules/contracts/guard'

type ResolvedGuardOptions = {
  readonly maxFailures: number
  readonly windowMs: number
  readonly configuredRetryAfterSeconds?: number
  readonly maxKeys: number
  readonly nowProvider: () => Date | number
}

export function assertOptions(options: ResolvedGuardOptions): void {
  if (!Number.isSafeInteger(options.maxFailures) || options.maxFailures <= 0 || options.maxFailures > 1000) {
    throw new TypeError('maxFailures must be a positive integer no greater than 1000')
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) {
    throw new TypeError('windowSeconds must be a positive integer')
  }
  if (options.configuredRetryAfterSeconds !== undefined
    && (!Number.isSafeInteger(options.configuredRetryAfterSeconds) || options.configuredRetryAfterSeconds <= 0)) {
    throw new TypeError('retryAfterSeconds must be a positive integer')
  }
  if (!Number.isSafeInteger(options.maxKeys) || options.maxKeys <= 0 || options.maxKeys > 100000) {
    throw new TypeError('maxKeys must be a positive integer no greater than 100000')
  }
  if (typeof options.nowProvider !== 'function') {
    throw new TypeError('now must be a function')
  }
}

export function isAttemptInput(input?: GuardBeforeAttemptInput): input is GuardBeforeAttemptInput {
  return Boolean(
    input &&
    isSafeText(input.context?.tenantId, 512) &&
    ['enroll', 'authenticate', 'begin', 'complete'].includes(input.operation) &&
    (input.challengeId === undefined || isSafeText(input.challengeId, 512)) &&
    isSafeText(input.method?.methodId, 512) &&
    isSafeText(input.method.methodKind, 512) &&
    (input.lookup === undefined || (isRecord(input.lookup) &&
      isSafeText(input.lookup.methodId, 512) &&
      isSafeText(input.lookup.methodKind, 512) &&
      isSafeText(input.lookup.subjectKind, 512) &&
      isSafeText(input.lookup.subject, 2048)
    ))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isOutcome(outcome?: GuardAfterAttemptInput['outcome']): outcome is GuardAfterAttemptInput['outcome'] {
  return Boolean(
    outcome &&
    typeof outcome.success === 'boolean' &&
    (outcome.success || (
      isSafeText(outcome.reason, 512) &&
      typeof outcome.countsAsAttempt === 'boolean'
    ))
  )
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}
