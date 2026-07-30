import type { DeliveryFailure, InternalAuthReason, SideEffectFailure } from '@authmodules/contracts/errors'
import type { PublicData } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'

export function effectsFailure(reason: InternalAuthReason, details?: PublicData): Result<never, SideEffectFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'effects',
      reason,
      details
    }
  }
}

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
