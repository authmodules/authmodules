import type { DeliveryFailure, InternalAuthReason, StoreFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'

export function deliveryFailure(): Result<never, DeliveryFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'delivery',
      reason: 'DELIVERY_FAILED'
    }
  }
}

export function workerStoreErr(reason: InternalAuthReason): Result<never, StoreFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'store',
      reason
    }
  }
}
