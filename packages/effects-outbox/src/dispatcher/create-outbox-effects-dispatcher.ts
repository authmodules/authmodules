import type { SideEffectFailure } from '@authmodules/contracts/errors'
import type {
  SideEffectDispatcher,
  DeliverySideEffectRequest,
  SideEffectDispatchFailure,
  SideEffectDispatchInput,
  SideEffectDispatchItem,
  SideEffectDispatchResult
} from '@authmodules/contracts/effects'
import type { OutboxMessage } from '@authmodules/contracts/extensions'
import type { Result } from '@authmodules/contracts/result'
import { type OutboxEffectsDispatcherOptions } from './types.ts'
import { snapshotDispatchInput } from './validation.ts'
import { outboxSecretPurpose } from '../delivery/outbox-secret-purpose.ts'
import { sealDeliveryMessage } from '../delivery/seal.ts'
import { snapshotDeliveryEffect } from '../delivery/validation.ts'
import { verifyEnqueueAcknowledgements } from '../outbox/acknowledgements.ts'
import { safeEnqueueBatch, safeGenerateId } from '../outbox/operations.ts'
import { normalizeDispatchContext } from '../shared/context.ts'
import { isSafeText, isValidDate } from '../shared/json.ts'
import { effectsErr } from '../shared/result.ts'

export function createOutboxEffectsDispatcher(options: OutboxEffectsDispatcherOptions): SideEffectDispatcher

export function createOutboxEffectsDispatcher(options?: OutboxEffectsDispatcherOptions): SideEffectDispatcher {
  if (!options) throw new TypeError('Outbox dispatcher options are required')
  const config: Partial<OutboxEffectsDispatcherOptions> = options ?? {}
  const store = config.store
  const sealer = config.sealer
  const maxAttempts = config.maxAttempts ?? 10
  const idGenerator = config.idGenerator
  const nowProvider = config.now
  if (!store || typeof store.enqueueBatch !== 'function') throw new TypeError('Outbox store is required')
  if (!sealer || typeof sealer.seal !== 'function' || typeof sealer.unseal !== 'function') {
    throw new TypeError('Secret sealer is required')
  }
  if (typeof idGenerator !== 'function') throw new TypeError('Outbox idGenerator is required')
  if (nowProvider !== undefined && typeof nowProvider !== 'function') {
    throw new TypeError('now must be a function')
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 1_000_000) {
    throw new TypeError('maxAttempts must be a positive integer no greater than 1000000')
  }

  return {
    transactionScopes: ['outbox'],
    async dispatch(input: SideEffectDispatchInput): Promise<Result<SideEffectDispatchResult, SideEffectFailure>> {
      const dispatchInput = snapshotDispatchInput(input)
      if (!dispatchInput) return effectsErr('SIDE_EFFECT_FAILED')
      const context = normalizeDispatchContext(dispatchInput.context)
      if (!context) return effectsErr('SIDE_EFFECT_FAILED')
      if (dispatchInput.tx && !dispatchInput.transactionScopes?.includes('outbox')) {
        return effectsErr('SIDE_EFFECT_FAILED')
      }
      const now = new Date(dispatchInput.now.getTime())
      const currentTime = createCurrentTime(now, nowProvider)
      const dispatched: SideEffectDispatchItem[] = []
      const failed: SideEffectDispatchFailure[] = []
      const prepared: Array<{
        readonly item: SideEffectDispatchItem
        readonly effect: DeliverySideEffectRequest
        readonly outboxMessage: OutboxMessage
      }> = []

      for (const [index, candidate] of dispatchInput.effects.entries()) {
        const item: SideEffectDispatchItem = { index, type: 'delivery' }
        const effect = snapshotDeliveryEffect(candidate)
        if (!effect) {
          if (!isBestEffort(candidate)) {
            return effectsErr('SIDE_EFFECT_FAILED')
          }
          failed.push({ ...item, reason: 'SIDE_EFFECT_FAILED' })
          continue
        }

        const messageId = safeGenerateId(idGenerator, {
          tenantId: context.tenantId,
          now: new Date(now.getTime()),
          effect: {
            type: effect.type,
            dispatchPolicy: effect.dispatchPolicy,
            ...(effect.idempotencyKey === undefined ? {} : {
              idempotencyKey: effect.idempotencyKey
            })
          },
          index
        })
        if (!isSafeText(messageId, 512) || messageId.length === 0
          || (effect.expiresAt !== undefined && (!isValidDate(effect.expiresAt) || effect.expiresAt <= now))) {
          if (effect.dispatchPolicy === 'required') {
            return effectsErr('SIDE_EFFECT_FAILED')
          }
          failed.push({ ...item, reason: 'SIDE_EFFECT_FAILED' })
          continue
        }
        const persistable = await sealDeliveryMessage({
          message: effect.message,
          sealer,
          tenantId: context.tenantId,
          messageId,
          expiresAt: effect.expiresAt
        })
        if (!persistable.ok) {
          if (effect.dispatchPolicy === 'required') {
            return effectsErr('SIDE_EFFECT_FAILED')
          }
          failed.push({ ...item, reason: 'SIDE_EFFECT_FAILED' })
          continue
        }
        const preparedAt = currentTime()
        if (!preparedAt) return effectsErr('SIDE_EFFECT_FAILED')
        if (effect.expiresAt && effect.expiresAt <= preparedAt) {
          if (effect.dispatchPolicy === 'required') {
            return effectsErr('SIDE_EFFECT_FAILED')
          }
          failed.push({ ...item, reason: 'SIDE_EFFECT_FAILED' })
          continue
        }

        const outboxMessage = {
          tenantId: context.tenantId,
          messageId,
          context,
          secretPurpose: outboxSecretPurpose(context.tenantId, messageId),
          type: 'delivery',
          message: persistable.value,
          dispatchPolicy: effect.dispatchPolicy,
          status: 'pending',
          attempts: 0,
          maxAttempts,
          idempotencyKey: effect.idempotencyKey,
          expiresAt: effect.expiresAt === undefined ? undefined : new Date(effect.expiresAt.getTime()),
          availableAt: new Date(preparedAt.getTime()),
          createdAt: new Date(preparedAt.getTime()),
          updatedAt: new Date(preparedAt.getTime())
        } as OutboxMessage
        prepared.push({
          item,
          effect,
          outboxMessage
        })
      }

      const required = prepared.filter(({ effect }) => effect.dispatchPolicy === 'required')
      let bestEffort = prepared.filter(({ effect }) => effect.dispatchPolicy === 'best-effort')

      if (required.length > 0) {
        const enqueueNow = currentTime()
        if (!enqueueNow
          || required.some(({ effect }) => effect.expiresAt && effect.expiresAt <= enqueueNow)) {
          return effectsErr('SIDE_EFFECT_FAILED')
        }
        const enqueued = await safeEnqueueBatch(store, {
          messages: required.map(({ outboxMessage }) => outboxMessage)
        }, dispatchInput.tx)
        if (!enqueued.ok) return effectsErr(enqueued.error.reason)
        const acknowledgedAt = currentTime()
        if (!acknowledgedAt) return effectsErr('SIDE_EFFECT_FAILED')
        if (!await verifyEnqueueAcknowledgements({
          sealer,
          prepared: required,
          acknowledged: enqueued.value,
          now: acknowledgedAt
        })) return effectsErr('STORE_UNAVAILABLE')
        dispatched.push(...required.map(({ item }) => item))
      }

      if (bestEffort.length > 0) {
        const enqueueNow = currentTime()
        if (!enqueueNow) return effectsErr('SIDE_EFFECT_FAILED')
        const expired = bestEffort.filter(
          ({ effect }) => effect.expiresAt && effect.expiresAt <= enqueueNow
        )
        for (const { item } of expired) {
          failed.push({ ...item, reason: 'SIDE_EFFECT_FAILED' })
        }
        const expiredIndexes = new Set(expired.map(({ item }) => item.index))
        bestEffort = bestEffort.filter(({ item }) => !expiredIndexes.has(item.index))
      }

      if (bestEffort.length > 0) {
        const enqueued = await safeEnqueueBatch(store, {
          messages: bestEffort.map(({ outboxMessage }) => outboxMessage)
        }, dispatchInput.tx)
        if (!enqueued.ok) {
          // A failed PostgreSQL statement aborts its surrounding transaction.
          // Never report success to a caller that supplied that transaction.
          if (dispatchInput.tx) return effectsErr(enqueued.error.reason)
          for (const { item } of bestEffort) {
            failed.push({
              ...item,
              reason: enqueued.error.reason,
              ...(enqueued.error.details === undefined ? {} : { details: enqueued.error.details })
            })
          }
        } else {
          const acknowledgedAt = currentTime()
          if (!acknowledgedAt) return effectsErr('SIDE_EFFECT_FAILED')
          const acknowledged = await verifyEnqueueAcknowledgements({
            sealer,
            prepared: bestEffort,
            acknowledged: enqueued.value,
            now: acknowledgedAt
          })
          if (acknowledged) {
            dispatched.push(...bestEffort.map(({ item }) => item))
          } else {
            if (dispatchInput.tx) return effectsErr('STORE_UNAVAILABLE')
            for (const { item } of bestEffort) {
              failed.push({
                ...item,
                reason: 'STORE_UNAVAILABLE'
              })
            }
          }
        }
      }

      return {
        ok: true,
        value: {
          dispatched: [],
          deferred: dispatched,
          failed: failed.length > 0 ? failed : undefined
        }
      }
    }
  }
}

function createCurrentTime(
  initial: Date,
  provider: OutboxEffectsDispatcherOptions['now']
): () => Date | undefined {
  const initialTime = Date.prototype.getTime.call(initial)
  const startedAt = Date.now()
  let previousTime = initialTime
  return () => {
    let candidate: unknown
    let candidateTime: number
    try {
      candidate = provider
        ? provider({ now: new Date(previousTime) })
        : new Date(initialTime + Math.max(0, Date.now() - startedAt))
      candidateTime = candidate instanceof Date
        ? Date.prototype.getTime.call(candidate)
        : Number.NaN
    } catch {
      return undefined
    }
    if (!Number.isFinite(candidateTime) || candidateTime < previousTime) {
      return undefined
    }
    previousTime = candidateTime
    return new Date(previousTime)
  }
}

function isBestEffort(value: unknown): boolean {
  try {
    return typeof value === 'object'
      && value !== null
      && 'dispatchPolicy' in value
      && value.dispatchPolicy === 'best-effort'
  } catch {
    return false
  }
}
