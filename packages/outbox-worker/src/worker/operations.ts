import type { DeliverySendInput, DeliverySuccess, DeliveryTransport } from '@authmodules/contracts/delivery'
import type { DeliveryFailure, StoreFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import { deliveryFailure, workerStoreErr } from '../shared/result.ts'
import { clonePublicData, isJsonObject, isSafeText } from '../shared/json.ts'

const componentFailureKeys = new Set(['component', 'details', 'reason', 'type'])
const deliverySuccessKeys = new Set(['acceptedAt', 'providerMessageId'])
const failureResultKeys = new Set(['error', 'ok'])
const successResultKeys = new Set(['ok', 'value'])

export async function safeStoreCall<T>(
  call: () => Promise<Result<T, StoreFailure>>
): Promise<Result<T, StoreFailure>> {
  try {
    const result = await call()
    if (isRecord(result)
      && result.ok === true
      && hasOnlyKeys(result, successResultKeys)
      && 'value' in result) {
      return result as Result<T, StoreFailure>
    }
    if (isRecord(result)
      && result.ok === false
      && hasOnlyKeys(result, failureResultKeys)
      && isStoreFailure(result.error)) {
      return {
        ok: false,
        error: snapshotFailure(result.error)
      }
    }
    return workerStoreErr('STORE_UNAVAILABLE')
  } catch {
    return workerStoreErr('STORE_UNAVAILABLE')
  }
}

export async function safeSend(
  transport: DeliveryTransport,
  input: DeliverySendInput
): Promise<Result<DeliverySuccess, DeliveryFailure>> {
  try {
    const result = await transport.send(input)
    const success = isRecord(result) && result.ok === true
      ? snapshotDeliverySuccess(result.value)
      : undefined
    if (isRecord(result)
      && result.ok === true
      && hasOnlyKeys(result, successResultKeys)
      && success) {
      return {
        ok: true,
        value: success
      }
    }
    if (isRecord(result)
      && result.ok === false
      && hasOnlyKeys(result, failureResultKeys)
      && isDeliveryFailure(result.error)) {
      return {
        ok: false,
        error: snapshotFailure(result.error)
      }
    }
    return deliveryFailure()
  } catch {
    return deliveryFailure()
  }
}

function isStoreFailure(value: unknown): value is StoreFailure {
  return isRecord(value)
    && hasOnlyKeys(value, componentFailureKeys)
    && value.type === 'component.failure'
    && value.component === 'store'
    && isSafeReason(value.reason)
    && (value.details === undefined || isJsonObject(value.details))
}

function isDeliveryFailure(value: unknown): value is DeliveryFailure {
  return isRecord(value)
    && hasOnlyKeys(value, componentFailureKeys)
    && value.type === 'component.failure'
    && value.component === 'delivery'
    && isSafeReason(value.reason)
    && (value.details === undefined || isJsonObject(value.details))
}

function snapshotDeliverySuccess(value: unknown): DeliverySuccess | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, deliverySuccessKeys)) return undefined
  const acceptedAtSource = value.acceptedAt
  const providerMessageId = value.providerMessageId
  if (!(acceptedAtSource instanceof Date)
    || (providerMessageId !== undefined
      && (!isSafeText(providerMessageId, 512) || providerMessageId.length === 0))) {
    return undefined
  }
  const acceptedAtTimestamp = Date.prototype.getTime.call(acceptedAtSource)
  if (!Number.isFinite(acceptedAtTimestamp)) return undefined
  return {
    acceptedAt: new Date(acceptedAtTimestamp),
    ...(providerMessageId === undefined ? {} : { providerMessageId })
  }
}

function snapshotFailure<T extends StoreFailure | DeliveryFailure>(value: T): T {
  return {
    type: 'component.failure',
    component: value.component,
    reason: value.reason,
    ...(value.details === undefined ? {} : { details: clonePublicData(value.details) })
  } as T
}

function isSafeReason(value: unknown): value is string {
  return isSafeText(value, 512) && value.length > 0
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
