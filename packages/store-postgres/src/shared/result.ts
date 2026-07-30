import type { InternalAuthReason, StoreFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'

export function storeErr(reason: InternalAuthReason): Result<never, StoreFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'store',
      reason
    }
  }
}
