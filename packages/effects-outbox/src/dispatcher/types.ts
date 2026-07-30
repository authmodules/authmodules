import type { SecretSealer } from '@authmodules/contracts/crypto'
import type { DeliverySideEffectRequest } from '@authmodules/contracts/effects'
import type { OutboxEnqueueStore } from '@authmodules/contracts/extensions'
import type { TenantId } from '@authmodules/contracts/primitives'

export type OutboxEffectsDispatcherOptions = {
  readonly store: OutboxEnqueueStore
  readonly sealer: SecretSealer
  readonly maxAttempts?: number
  /** Override only when the host uses a custom or simulated clock. Must never move backwards. */
  readonly now?: (input: { readonly now: Date }) => Date
  readonly idGenerator: (input: {
    readonly tenantId: TenantId
    readonly now: Date
    readonly effect: {
      readonly type: DeliverySideEffectRequest['type']
      readonly dispatchPolicy: DeliverySideEffectRequest['dispatchPolicy']
      readonly idempotencyKey?: string
    }
    readonly index: number
  }) => string
}
