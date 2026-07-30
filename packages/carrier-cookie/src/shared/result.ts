import type { CarrierFailure, InternalAuthReason } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function carrierErr(reason: InternalAuthReason): Result<never, CarrierFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'carrier',
      reason
    }
  }
}
