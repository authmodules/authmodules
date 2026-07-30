import { isJsonObject, isSafeText } from '../shared/json.ts'
import type { DeliveryMessage } from '@authmodules/contracts/delivery'
import type { DeliverySideEffectRequest } from '@authmodules/contracts/effects'

type TraversalState = { visiting: Set<object>; nodes: number; characters: number }
const secretDescriptorTypes = new Set<unknown>(['raw-secret', 'protected-value', 'sealed-secret'])
const rawSecretKeys = new Set(['redacted', 'reveal', 'toJSON', 'type'])
const effectKeys = new Set(['dispatchPolicy', 'expiresAt', 'idempotencyKey', 'message', 'type'])
const messageKeys = new Set(['data', 'locale', 'metadata', 'templateId', 'to'])
const addressKeys = new Set(['channel', 'display', 'target'])

export function isDeliveryEffect(effect?: unknown): effect is DeliverySideEffectRequest {
  return Boolean(
    isPlainObject(effect) &&
    hasOnlyKeys(effect, effectKeys) &&
    effect.type === 'delivery' &&
    (effect.dispatchPolicy === 'required' || effect.dispatchPolicy === 'best-effort') &&
    isDeliveryMessage(effect.message) &&
    (effect.idempotencyKey === undefined
      ? effect.dispatchPolicy === 'best-effort'
      : isSafeText(effect.idempotencyKey, 512) && effect.idempotencyKey.length > 0) &&
    (effect.expiresAt === undefined || (
      effect.expiresAt instanceof Date &&
      !Number.isNaN(effect.expiresAt.getTime())
    ))
  )
}

function isDeliveryMessage(message?: unknown): message is DeliveryMessage {
  return Boolean(
    isPlainObject(message) &&
    isPlainObject(message.to) &&
    hasOnlyKeys(message, messageKeys) &&
    hasOnlyKeys(message.to, addressKeys) &&
    isSafeText(message.to.channel, 64) &&
    message.to.channel.length > 0 &&
    isSafeText(message.to.target, 2048) &&
    message.to.target.length > 0 &&
    (message.to.display === undefined || isSafeText(message.to.display, 512)) &&
    isSafeText(message.templateId, 256) &&
    message.templateId.length > 0 &&
    (message.locale === undefined || (isSafeText(message.locale, 128) && message.locale.length > 0)) &&
    (message.data === undefined || isDeliveryData(message.data)) &&
    (message.metadata === undefined || isJsonObject(message.metadata))
  )
}

function isDeliveryData(value?: unknown): boolean {
  if (!isPlainObject(value)) return false
  const state: TraversalState = { visiting: new Set<object>(), nodes: 0, characters: 0 }
  return Object.entries(value).every(([key, item]: [string, unknown]): boolean => (
    consumeText(key, 512, state)
    && key.length > 0
    && (isRawSecret(item) || isJsonValue(item, 0, state))
  ))
}

function isJsonValue(value: unknown, depth: number, state: TraversalState): boolean {
  state.nodes += 1
  if (state.nodes > 1000) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return consumeText(value, 65536, state)
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || value instanceof Date || depth >= 16) return false
  if (isSecretDescriptor(value)) return false
  if (hasFunction(value, 'reveal')
    || hasFunction(value, 'revealForPersistence')
    || hasFunction(value, 'revealCiphertextForPersistence')
    || state.visiting.has(value)) return false
  state.visiting.add(value)
  const valid = Array.isArray(value)
    ? isDenseJsonArray(value) && value.every((item: unknown): boolean => isJsonValue(item, depth + 1, state))
    : isPlainObject(value) && Object.entries(value).every(([key, item]): boolean => (
      consumeText(key, 512, state) && key.length > 0 && isJsonValue(item, depth + 1, state)
    ))
  state.visiting.delete(value)
  return valid
}

function consumeText(value: unknown, maxLength: number, state: TraversalState): value is string {
  if (!isSafeText(value, maxLength)) return false
  state.characters += value.length
  return state.characters <= 1_000_000
}

function isDenseJsonArray(value: unknown[]): boolean {
  const keys = Object.keys(value)
  return keys.length === value.length && keys.every((key, index) => key === String(index))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isRawSecret(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, rawSecretKeys)
    && value.type === 'raw-secret'
    && typeof value.redacted === 'string'
    && typeof value.reveal === 'function'
    && typeof value.toJSON === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}

function isSecretDescriptor(value: object): boolean {
  return !Array.isArray(value) && 'type' in value && secretDescriptorTypes.has(value.type)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
