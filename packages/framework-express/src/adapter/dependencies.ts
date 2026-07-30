import type { HttpTokenCarrier, TokenCarrierReadResult } from '@authmodules/contracts/carrier'
import type { CarrierFailure } from '@authmodules/contracts/errors'
import type { TenantId } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import type { RawSecretValue } from '@authmodules/contracts/security'
import { toHttpRequestView } from '../http/request.ts'
import { isSafeContextText } from '../shared/context-text.ts'
import { carrierFailure } from '../shared/errors.ts'
import type { ExpressAuthAdapterOptions, ExpressLikeRequest } from './types.ts'

const carrierFailureKeys = new Set(['component', 'details', 'reason', 'type'])
const carrierResultKeys = new Set(['error', 'ok', 'value'])
const foundTokenKeys = new Set(['found', 'token'])
const missingTokenKeys = new Set(['found'])
const rawSecretKeys = new Set(['redacted', 'reveal', 'toJSON', 'type'])

export function resolvedTenant(
  tenantResolver: ExpressAuthAdapterOptions['tenantResolver'],
  req: ExpressLikeRequest
): TenantId {
  const tenantId = tenantResolver(req)
  if (!isSafeContextText(tenantId, 512) || tenantId.length === 0) throw new TypeError('tenantResolver returned an invalid tenantId')
  return tenantId
}

export function safeCarrierRead(
  carrier: HttpTokenCarrier,
  req: ExpressLikeRequest
): Result<TokenCarrierReadResult, CarrierFailure> {
  try {
    const result = carrier.read(toHttpRequestView(req))
    if (isRecord(result)
      && hasOnlyKeys(result, carrierResultKeys)
      && result.ok === true
      && !('error' in result)
      && isRecord(result.value)) {
      if (result.value.found === false && hasOnlyKeys(result.value, missingTokenKeys)) {
        return { ok: true, value: { found: false } }
      }
      if (result.value.found === true && hasOnlyKeys(result.value, foundTokenKeys)) {
        const token = snapshotRawStringSecret(result.value.token)
        if (token) return { ok: true, value: { found: true, token } }
      }
    }
    if (isRecord(result)
      && hasOnlyKeys(result, carrierResultKeys)
      && result.ok === false
      && !('value' in result)
      && isCarrierFailure(result.error)) {
      return {
        ok: false,
        error: {
          type: 'component.failure',
          component: 'carrier',
          reason: result.error.reason,
          ...(result.error.details === undefined
            ? {}
            : { details: structuredClone(result.error.details) })
        }
      }
    }
    return carrierFailure('VALIDATION_FAILED')
  } catch {
    return carrierFailure('INTERNAL')
  }
}

function snapshotRawStringSecret(value: unknown): RawSecretValue<string> | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, rawSecretKeys)
    || value.type !== 'raw-secret'
    || typeof value.reveal !== 'function') return null
  try {
    const revealed = Reflect.apply(value.reveal, value, [])
    if (typeof revealed !== 'string'
      || revealed.length === 0
      || revealed.length > 65_536
      || /[\u0000-\u001f\u007f]/.test(revealed)) return null
    return Object.freeze({
      type: 'raw-secret' as const,
      redacted: '[REDACTED]',
      reveal() {
        return revealed
      },
      toJSON() {
        return '[REDACTED]'
      }
    })
  } catch {
    return null
  }
}

function isCarrierFailure(value: unknown): value is CarrierFailure {
  return isRecord(value)
    && Object.keys(value).every((key) => carrierFailureKeys.has(key))
    && value.type === 'component.failure'
    && value.component === 'carrier'
    && isSafeContextText(value.reason, 512)
    && value.reason.length > 0
    && (value.details === undefined || isPublicData(value.details))
}

function isPublicData(value: unknown): boolean {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  const state: JsonState = { seen: new Set<object>(), nodes: 0, characters: 0 }
  return Object.entries(value).every(([key, item]) => consumeText(key, 512, state)
    && key.length > 0
    && isJsonValue(item, 0, state))
}

function isJsonValue(value: unknown, depth: number, state: JsonState): boolean {
  state.nodes += 1
  if (state.nodes > 1000) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return consumeText(value, 65536, state)
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || value instanceof Date || depth >= 16 || state.seen.has(value)) return false
  if ('type' in value && ['protected-value', 'raw-secret', 'sealed-secret'].includes(String(value.type))) return false
  state.seen.add(value)
  const valid = Array.isArray(value)
    ? isDenseJsonArray(value) && value.every((item) => isJsonValue(item, depth + 1, state))
    : isPlainObject(value) && Object.entries(value).every(([key, item]) => consumeText(key, 512, state)
      && key.length > 0
      && isJsonValue(item, depth + 1, state))
  state.seen.delete(value)
  return valid
}

function consumeText(value: unknown, maxLength: number, state: JsonState): value is string {
  if (!isSafeContextText(value, maxLength)) return false
  state.characters += value.length
  return state.characters <= 1_000_000
}

function isDenseJsonArray(value: unknown[]): boolean {
  const keys = Object.keys(value)
  return keys.length === value.length && keys.every((key, index) => key === String(index))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

type JsonState = {
  readonly seen: Set<object>
  nodes: number
  characters: number
}
