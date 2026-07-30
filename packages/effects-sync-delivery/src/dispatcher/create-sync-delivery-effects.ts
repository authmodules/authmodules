import type { DeliveryTransport } from '@authmodules/contracts/delivery'
import type {
  DeliverySideEffectRequest,
  SideEffectDispatchFailure,
  SideEffectDispatchInput,
  SideEffectDispatchItem,
  SideEffectDispatcher
} from '@authmodules/contracts/effects'
import type { DeliveryData, RawSecretValue } from '@authmodules/contracts/security'
import { snapshotDispatchInput } from './validation.ts'
import { safeSend } from '../delivery/send.ts'
import { isDeliveryEffect } from '../delivery/validation.ts'
import { normalizeDispatchContext } from '../shared/context.ts'
import { effectsFailure } from '../shared/result.ts'

export type SyncDeliveryEffectsOptions = {
  readonly transport: DeliveryTransport
  readonly now?: (input: { readonly now: Date }) => Date
}

export function createSyncDeliveryEffects(options: SyncDeliveryEffectsOptions): SideEffectDispatcher

export function createSyncDeliveryEffects(options: SyncDeliveryEffectsOptions): SideEffectDispatcher {
  if (!options || typeof options.transport?.send !== 'function') {
    throw new TypeError('Delivery transport is required')
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function')
  }
  const transport = options.transport
  const nowProvider = options.now

  return {
    async dispatch(input?: SideEffectDispatchInput) {
      const dispatchInput = snapshotDispatchInput(input)
      if (!dispatchInput) return effectsFailure('SIDE_EFFECT_FAILED')
      const context = normalizeDispatchContext(dispatchInput.context)
      if (!context) return effectsFailure('SIDE_EFFECT_FAILED')
      const now = new Date(dispatchInput.now.getTime())
      const currentTime = createCurrentTime(now, nowProvider)
      const dispatched: SideEffectDispatchItem[] = []
      const failed: SideEffectDispatchFailure[] = []
      const deliverable: Array<{ index: number; effect: DeliverySideEffectRequest }> = []

      for (const [index, effect] of dispatchInput.effects.entries()) {
        const dispatchPolicy = isRecord(effect) ? effect.dispatchPolicy : undefined
        let snapshot: DeliverySideEffectRequest | undefined
        try {
          snapshot = snapshotEffect(effect)
        } catch {
          snapshot = undefined
        }
        if (!snapshot || (snapshot.expiresAt && snapshot.expiresAt <= now)) {
          const failure = {
            index,
            type: 'delivery' as const,
            reason: 'SIDE_EFFECT_FAILED'
          }
          if (dispatchPolicy !== 'best-effort') return effectsFailure('SIDE_EFFECT_FAILED')
          failed.push(failure)
          continue
        }
        deliverable.push({ index, effect: snapshot })
      }

      for (const { index, effect } of deliverable) {
        const deliveryNow = currentTime()
        if (!deliveryNow) return effectsFailure('SIDE_EFFECT_FAILED')
        if (effect.expiresAt && effect.expiresAt <= deliveryNow) {
          const failure = {
            index,
            type: effect.type,
            reason: 'SIDE_EFFECT_FAILED'
          } as const
          if (effect.dispatchPolicy === 'required') return effectsFailure('SIDE_EFFECT_FAILED')
          failed.push(failure)
          continue
        }
        const result = await safeSend(transport, {
          context: structuredClone(context),
          message: effect.message,
          idempotencyKey: effect.idempotencyKey,
          ...(effect.expiresAt === undefined ? {} : { expiresAt: effect.expiresAt }),
          now: deliveryNow
        })

        if (result.ok) {
          dispatched.push({ index, type: effect.type })
          continue
        }

        if (effect.dispatchPolicy === 'required') {
          return effectsFailure(result.error.reason, result.error.details)
        }

        failed.push({
          index,
          type: effect.type,
          reason: result.error.reason,
          details: result.error.details
        })
      }

      return {
        ok: true,
        value: {
          dispatched,
          failed: failed.length > 0 ? failed : undefined
        }
      }
    }
  }
}

function createCurrentTime(
  initial: Date,
  provider: SyncDeliveryEffectsOptions['now']
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

function snapshotEffect(effect: unknown): DeliverySideEffectRequest | undefined {
  if (!isPlainObject(effect)) return undefined
  const type = effect.type
  const dispatchPolicy = effect.dispatchPolicy
  const idempotencyKey = effect.idempotencyKey
  const expiresAt = effect.expiresAt
  const messageSource = effect.message
  if (!isPlainObject(messageSource)) return undefined
  const toSource = messageSource.to
  if (!isPlainObject(toSource)) return undefined
  const channel = toSource.channel
  const target = toSource.target
  const display = toSource.display
  const templateId = messageSource.templateId
  const dataSource = messageSource.data
  const locale = messageSource.locale
  const metadataSource = messageSource.metadata
  const dataBudget = { secretCharacters: 0 }
  const message = {
    to: {
      channel,
      target,
      display
    },
    templateId,
    data: snapshotDeliveryData(dataSource as DeliveryData | undefined, dataBudget),
    locale,
    metadata: metadataSource === undefined ? undefined : structuredClone(metadataSource)
  }
  const snapshot = dispatchPolicy === 'required'
    ? ({
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey,
        expiresAt: expiresAt instanceof Date ? new Date(expiresAt.getTime()) : expiresAt,
        message
      } as const)
    : ({
        type: 'delivery',
        dispatchPolicy,
        idempotencyKey,
        expiresAt: expiresAt instanceof Date ? new Date(expiresAt.getTime()) : expiresAt,
        message
      } as const)
  return type === 'delivery' && isDeliveryEffect(snapshot) ? snapshot : undefined
}

function snapshotDeliveryData(
  data: DeliveryData | undefined,
  budget: { secretCharacters: number }
): DeliveryData | undefined {
  if (!data) return undefined
  return Object.fromEntries(Object.entries(data).map(([key, value]) => {
    const secret = snapshotRawSecret(value, budget)
    return [key, secret ?? structuredClone(value)]
  }))
}

function snapshotRawSecret(
  value: unknown,
  budget: { secretCharacters: number }
): RawSecretValue | undefined {
  if (!isRecord(value)) return undefined
  const type = value.type
  if (type !== 'raw-secret') return undefined
  const reveal = value.reveal
  if (typeof reveal !== 'function') throw new TypeError('Raw secret is invalid')
  const revealed = reveal.call(value)
  if (typeof revealed !== 'string' || revealed.length === 0) throw new TypeError('Raw secret is invalid')
  budget.secretCharacters += revealed.length
  if (budget.secretCharacters > 1_000_000) throw new TypeError('Delivery secrets are too large')
  const redacted = '[REDACTED]'
  return Object.freeze({
    type: 'raw-secret' as const,
    redacted,
    reveal() {
      return revealed
    },
    toJSON() {
      return redacted
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
