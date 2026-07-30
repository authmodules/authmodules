import type { InternalAuthReason, TokenFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'

export function tokenErr(reason: InternalAuthReason): Result<never, TokenFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'token',
      reason
    }
  }
}
