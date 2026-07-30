import type { OutboxStore } from '@authmodules/contracts/extensions'
import type { AuthStore } from '@authmodules/contracts/store'
import type { Clock } from '@authmodules/contracts/primitives'
import type { Auth } from '@authmodules/contracts/core'
import type { AuthMethod } from '@authmodules/contracts/method'
import type { TokenFormat } from '@authmodules/contracts/token'
import type { HttpTokenCarrier } from '@authmodules/contracts/carrier'
import type { DeliveryTransport } from '@authmodules/contracts/delivery'
import type { DeliverySendInput } from '@authmodules/contracts/delivery'
import type { SideEffectDispatcher } from '@authmodules/contracts/effects'
import type { StoreFailure } from '@authmodules/contracts/errors'
import type { AuthGuard } from '@authmodules/contracts/guard'
import type { Result } from '@authmodules/contracts/result'
import type {
  SecretSealer
} from '@authmodules/contracts/crypto'
import type { SecretFactory as ContractSecretFactory } from '@authmodules/contracts/security'

export type ComplianceOutboxWorker = {
  runOnce(input: {
    readonly now: Date
    readonly tenantId?: string
    readonly limit?: number
  }): Promise<Result<{
    readonly claimed: number
    readonly dispatched: number
    readonly failed: number
  }, StoreFailure>>
}

export type ComplianceCase = {
  readonly name: string
  readonly run: (harness: ComplianceHarness) => Promise<void> | void
}

export type ComplianceSuite = {
  readonly name: string
  readonly cases: readonly ComplianceCase[]
}

export type ComplianceHarness = {
  readonly auth?: Auth
  readonly method?: AuthMethod
  readonly store?: AuthStore
  readonly token?: TokenFormat
  readonly carrier?: HttpTokenCarrier
  readonly delivery?: DeliveryTransport
  readonly effects?: SideEffectDispatcher
  readonly guard?: AuthGuard
  readonly guardFailureThreshold?: number
  readonly outbox?: OutboxStore
  readonly outboxWorker?: ComplianceOutboxWorker
  readonly deliveries?: readonly DeliverySendInput[]
  readonly sealer?: SecretSealer
  readonly secretFactory?: ContractSecretFactory
  readonly clock?: Clock
}

export type ComplianceSuiteCatalog = {
  readonly boundary: ComplianceSuite
  readonly coreFlows: ComplianceSuite
  readonly method: ComplianceSuite
  readonly store: ComplianceSuite
  readonly token: ComplianceSuite
  readonly carrier: ComplianceSuite
  readonly deliveryEffects: ComplianceSuite
  readonly security: ComplianceSuite
  readonly guardOutboxProfile: ComplianceSuite
}
