import type {
  AuthFailure,
  CarrierFailure,
  InternalAuthReason,
  PublicAuthErrorCode
} from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'

export function carrierFailure(reason: InternalAuthReason): Result<never, CarrierFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'carrier',
      reason
    }
  }
}

export function authFailure(
  reason: InternalAuthReason,
  code: PublicAuthErrorCode
): Result<never, AuthFailure> {
  return {
    ok: false,
    error: {
      type: 'auth.failure',
      internalReason: reason,
      publicError: {
        code,
        message: 'Authentication request failed.'
      }
    }
  }
}
