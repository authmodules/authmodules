import type { SecretSealer } from '@authmodules/contracts/crypto'
import type { DeliveryTransport } from '@authmodules/contracts/delivery'
import type { StoreFailure } from '@authmodules/contracts/errors'
import type { OutboxWorkerStore } from '@authmodules/contracts/extensions'
import type { TenantId } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'

export type OutboxWorkerRunInput = {
  readonly now: Date
  readonly tenantId?: TenantId
  readonly limit?: number
}

export type OutboxWorkerRunResult = {
  readonly claimed: number
  readonly dispatched: number
  readonly failed: number
}

export type OutboxWorker = {
  runOnce(input: OutboxWorkerRunInput): Promise<Result<OutboxWorkerRunResult, StoreFailure>>
}

export type OutboxWorkerOptions = {
  readonly store: OutboxWorkerStore
  readonly transport: DeliveryTransport
  readonly sealer: SecretSealer
  readonly workerId: string
  readonly leaseSeconds?: number
  readonly limit?: number
  readonly retryDelaySeconds?: number
}
