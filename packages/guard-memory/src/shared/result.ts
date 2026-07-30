import type { GuardFailure, InternalAuthReason } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'

export function guardErr(reason: InternalAuthReason): Result<never, GuardFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'guard',
      reason
    }
  }
}
