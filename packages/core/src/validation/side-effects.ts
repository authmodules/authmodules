import type { CreateAuthConfig } from '@authmodules/contracts/core'
import type { SideEffectRequest } from '@authmodules/contracts/effects'
import type { RawSecretValue } from '@authmodules/contracts/security'
import type { TransactionScope } from '@authmodules/contracts/transaction'
import { isPublicData, isValidDate } from './input.ts'

const addressKeys = new Set(['channel', 'display', 'target'])
const effectKeys = new Set(['dispatchPolicy', 'expiresAt', 'idempotencyKey', 'message', 'type'])
const messageKeys = new Set(['data', 'locale', 'metadata', 'templateId', 'to'])
const rawSecretKeys = new Set(['redacted', 'reveal', 'toJSON', 'type'])

export function isSideEffects(value: unknown): value is readonly SideEffectRequest[] | undefined {
  return value === undefined || (Array.isArray(value)
    && value.length <= 1000
    && value.every(isDeliveryEffect))
}

export function requiredEffectsCanPersist(
  config: CreateAuthConfig,
  effects: readonly SideEffectRequest[] | undefined,
  operationWrites: boolean
): boolean {
  const hasRequired = effects?.some((effect) => effect.dispatchPolicy === 'required') ?? false
  if (!hasRequired) return true
  if (!config.effects) return false
  const scopes = sideEffectScopes(config, effects)
  if (operationWrites && scopes.length === 0) return false
  return (!operationWrites && scopes.length === 0) || Boolean(config.store.transaction)
}

export function sideEffectScopes(
  config: CreateAuthConfig,
  effects: readonly SideEffectRequest[] | undefined
): readonly TransactionScope[] {
  if (!effects?.some((effect) => effect.dispatchPolicy === 'required')) return []
  const scopes = config.effects?.transactionScopes
  if (!Array.isArray(scopes)) return []
  return [...new Set(scopes)]
}

function isDeliveryEffect(value: unknown): value is SideEffectRequest {
  return isRecord(value)
    && hasOnlyKeys(value, effectKeys)
    && value.type === 'delivery'
    && (value.dispatchPolicy === 'required' || value.dispatchPolicy === 'best-effort')
    && isDeliveryMessage(value.message)
    && (value.idempotencyKey === undefined
      ? value.dispatchPolicy === 'best-effort'
      : isSafeText(value.idempotencyKey, 512, true))
    && (value.expiresAt === undefined || isValidDate(value.expiresAt))
}

function isDeliveryMessage(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, messageKeys)
    && isRecord(value.to)
    && hasOnlyKeys(value.to, addressKeys)
    && isSafeText(value.to.channel, 64, true)
    && isSafeText(value.to.target, 2048, true)
    && (value.to.display === undefined || isSafeText(value.to.display, 512, false))
    && isSafeText(value.templateId, 256, true)
    && (value.locale === undefined || isSafeText(value.locale, 128, true))
    && (value.data === undefined || isDeliveryData(value.data))
    && isPublicData(value.metadata)
}

function isDeliveryData(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).length <= 1000
    && Object.entries(value).every(([key, item]) => isSafeText(key, 512, true)
      && (isRawSecret(item) || isPublicData({ value: item })))
}

function isRawSecret(value: unknown): value is RawSecretValue {
  return isRecord(value)
    && hasOnlyKeys(value, rawSecretKeys)
    && value.type === 'raw-secret'
    && typeof value.redacted === 'string'
    && typeof value.reveal === 'function'
    && typeof value.toJSON === 'function'
}

function isSafeText(value: unknown, maxLength: number, requireNonEmpty: boolean): value is string {
  return typeof value === 'string'
    && (!requireNonEmpty || value.length > 0)
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
