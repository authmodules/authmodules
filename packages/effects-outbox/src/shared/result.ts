import type { InternalAuthReason, SideEffectFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'

export function effectsErr(reason: InternalAuthReason): Result<never, SideEffectFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'effects',
      reason
    }
  }
}
