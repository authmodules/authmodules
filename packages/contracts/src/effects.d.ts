import type { Result } from './result.js'
import type { DispatchContext } from './primitives.js'
import type { DeliveryMessage } from './delivery.js'
import type { SideEffectFailure } from './errors.js'
import type { TransactionContext } from './transaction.js'
import type { TransactionScope } from './transaction.js'

export type SideEffectDispatchPolicy = 'required' | 'best-effort'

/** Alias kept for role clarity. Shape is centralized in primitives.DispatchContext. */
export type SideEffectContext = DispatchContext

type DeliverySideEffectBase = {
  readonly type: 'delivery'
  readonly message: DeliveryMessage
  /** Optional deadline after which a deferred dispatcher must not deliver the effect. */
  readonly expiresAt?: Date
}

/** Stable baseline side effects are delivery-only. Non-delivery effects are future extensions. */
export type DeliverySideEffectRequest =
  | DeliverySideEffectBase & {
      readonly dispatchPolicy: 'required'
      /** Stable logical key that enables deduplication by a capable transport or provider. */
      readonly idempotencyKey: string
    }
  | DeliverySideEffectBase & {
      readonly dispatchPolicy: 'best-effort'
      readonly idempotencyKey?: string
    }

export type SideEffectRequest = DeliverySideEffectRequest

export type SideEffectDispatchInput = {
  /** Privacy-narrowed context derived from AuthContext by core. */
  readonly context: SideEffectContext
  readonly effects: readonly SideEffectRequest[]
  readonly now: Date
  /** Optional store transaction supplied by core when the dispatcher can participate. */
  readonly tx?: TransactionContext
}

export type SideEffectDispatchItem = {
  readonly index: number
  readonly type: SideEffectRequest['type']
}

export type SideEffectDispatchFailure = SideEffectDispatchItem & {
  /** Diagnostic only. Required-effect failure is represented by Result.ok=false. */
  readonly reason: SideEffectFailure['reason']
  readonly details?: SideEffectFailure['details']
}

export type SideEffectDispatchResult = {
  readonly dispatched: readonly SideEffectDispatchItem[]
  readonly deferred?: readonly SideEffectDispatchItem[]
  /** Best-effort effect failures may be returned here while dispatch itself remains ok. */
  readonly failed?: readonly SideEffectDispatchFailure[]
}

/**
 * Core knows only this port; sync delivery, outbox and no-op modes are implementations.
 * The dispatcher receives privacy-narrowed SideEffectContext, not full AuthContext.
 * Required-effect failure must return Result.ok=false. Best-effort failures may return
 * Result.ok=true with failed[] diagnostics.
 */
export interface SideEffectDispatcher {
  /** Store scopes required to persist required effects atomically with operation writes. */
  readonly transactionScopes?: readonly TransactionScope[]
  dispatch(input: SideEffectDispatchInput): Promise<Result<SideEffectDispatchResult, SideEffectFailure>>
}
