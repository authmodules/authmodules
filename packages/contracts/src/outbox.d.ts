import type { Result } from './result.js'
import type { InternalAuthReason, StoreFailure } from './errors.js'
import type { DispatchContext, TenantId } from './primitives.js'
import type { PersistableDeliveryData } from './security.js'
import type { DeliveryMessage } from './delivery.js'
import type { TransactionContext } from './transaction.js'

export type OutboxMessageId = string

export type OutboxInternalReason = 'OUTBOX_ENQUEUE_FAILED' | 'OUTBOX_LEASE_CONFLICT'

export type PersistableDeliveryMessage = Omit<DeliveryMessage, 'data'> & {
  readonly data?: PersistableDeliveryData
}

type OutboxMessageBase = {
  readonly tenantId: TenantId
  readonly messageId: OutboxMessageId
  readonly context: DispatchContext
  /** Authenticated purpose used to seal every secret value in this message. */
  readonly secretPurpose: string
  readonly type: 'delivery'
  readonly message: PersistableDeliveryMessage
  readonly status: 'pending' | 'claimed' | 'dispatched' | 'failed' | 'dead'
  readonly attempts: number
  readonly maxAttempts: number
  /** Last bounded worker/store processing failure, including abandoned lease reclaim. */
  readonly lastFailureReason?: InternalAuthReason | OutboxInternalReason
  readonly expiresAt?: Date
  readonly availableAt: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type OutboxMessage =
  | OutboxMessageBase & {
      readonly dispatchPolicy: 'required'
      readonly idempotencyKey: string
    }
  | OutboxMessageBase & {
      readonly dispatchPolicy: 'best-effort'
      readonly idempotencyKey?: string
    }

export type OutboxLease = {
  readonly leaseId: string
  readonly workerId: string
  readonly leaseUntil: Date
}

export type LeasedOutboxMessage = OutboxMessage & {
  readonly lease: OutboxLease
}

/**
 * Atomic enqueue capability used by effects-outbox. Batch order is preserved.
 * A duplicate tenant/idempotency key returns the original stored record in the
 * corresponding position without replacing it.
 */
export interface OutboxEnqueueStore {
  enqueue(input: { readonly message: OutboxMessage }, tx?: TransactionContext): Promise<Result<OutboxMessage, StoreFailure>>
  enqueueBatch(input: { readonly messages: readonly OutboxMessage[] }, tx?: TransactionContext): Promise<Result<readonly OutboxMessage[], StoreFailure>>
}

/** Lease-aware processing capability used by outbox workers. */
export interface OutboxWorkerStore {
  claimBatch(input: { readonly now: Date; readonly limit: number; readonly workerId: string; readonly leaseSeconds: number; readonly tenantId?: TenantId }): Promise<Result<readonly LeasedOutboxMessage[], StoreFailure>>
  renewLease(input: { readonly tenantId: TenantId; readonly messageId: OutboxMessageId; readonly workerId: string; readonly leaseId: string; readonly now: Date; readonly leaseSeconds: number }): Promise<Result<OutboxLease, StoreFailure>>
  markDispatched(input: { readonly tenantId: TenantId; readonly messageId: OutboxMessageId; readonly workerId: string; readonly leaseId: string; readonly now: Date }): Promise<Result<void, StoreFailure>>
  markFailed(input: { readonly tenantId: TenantId; readonly messageId: OutboxMessageId; readonly workerId: string; readonly leaseId: string; readonly now: Date; readonly reason: InternalAuthReason | OutboxInternalReason; readonly retryAt?: Date; readonly terminal?: boolean }): Promise<Result<void, StoreFailure>>
}

export type OutboxTerminalStatus = 'dispatched' | 'dead'

/** Bounded terminal-record retention capability. */
export interface OutboxRetentionStore {
  cleanupTerminal(input: { readonly before: Date; readonly statuses: readonly OutboxTerminalStatus[]; readonly limit: number; readonly tenantId?: TenantId }): Promise<Result<number, StoreFailure>>
}

/** Aggregate extension implemented by the official PostgreSQL and in-memory stores. */
export interface OutboxStore extends OutboxEnqueueStore, OutboxWorkerStore, OutboxRetentionStore {}
