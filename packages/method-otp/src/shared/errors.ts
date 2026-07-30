import type { InternalAuthReason, MethodFailure, PublicAuthErrorCode } from '@authmodules/contracts/errors'
import type { Result, ValidationFailure } from '@authmodules/contracts/result'

export function validationError(path: string): Result<never, ValidationFailure> {
  return {
    ok: false,
    error: {
      type: 'validation.failure',
      issues: [
        {
          path: [path],
          code: 'invalid',
          message: 'Invalid method input.'
        }
      ]
    }
  }
}

export function methodErr(
  reason: InternalAuthReason,
  countsAsAttempt = false,
  safePublicCodeHint?: PublicAuthErrorCode
): Result<never, MethodFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'method',
      reason,
      countsAsAttempt,
      safePublicCodeHint
    }
  }
}
