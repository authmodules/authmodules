import type { Result } from './result.js'
import type { DispatchContext, PublicData } from './primitives.js'
import type { DeliveryData } from './security.js'
import type { DeliveryFailure } from './errors.js'

export type DeliveryAddress = {
  readonly channel: string
  readonly target: string
  readonly display?: string
}

/** Template-first message. Rendered subject/text/html are intentionally not core-side fields. */
export type DeliveryMessage = {
  readonly to: DeliveryAddress
  readonly templateId: string
  readonly data?: DeliveryData
  /** Overrides DeliveryContext.locale for this message when present. Effective locale is message.locale ?? context.locale. */
  readonly locale?: string
  /** Transport/provider hint; must be public and secret-free. */
  readonly metadata?: PublicData
}

/** Alias kept for role clarity. Shape is centralized in primitives.DispatchContext. */
export type DeliveryContext = DispatchContext

export type DeliverySuccess = {
  readonly providerMessageId?: string
  readonly acceptedAt: Date
}

export type DeliverySendInput = {
  /** Privacy-narrowed context derived from AuthContext by core/effects. */
  readonly context: DeliveryContext
  readonly message: DeliveryMessage
  /**
   * Stable key for one logical delivery. Transports must forward or apply it
   * when the provider supports durable deduplication. The key alone does not
   * provide exactly-once delivery, so duplicates remain possible otherwise.
   */
  readonly idempotencyKey?: string
  /** Absolute delivery deadline. A transport must fail before contacting its provider once this instant is reached. */
  readonly expiresAt?: Date
  readonly now: Date
}

export interface DeliveryTransport {
  send(input: DeliverySendInput): Promise<Result<DeliverySuccess, DeliveryFailure>>
}
