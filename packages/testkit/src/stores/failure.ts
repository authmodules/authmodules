import type { InternalAuthReason, StoreFailure } from '@authmodules/contracts/errors'
import type { PublicData } from '@authmodules/contracts/primitives'

export function storeFailure(reason: InternalAuthReason, details?: PublicData): StoreFailure {
  return {
    type: 'component.failure',
    component: 'store',
    reason,
    details
  }
}
