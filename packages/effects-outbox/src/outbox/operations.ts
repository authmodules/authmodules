import type { StoreFailure } from '@authmodules/contracts/errors'
import type { OutboxEnqueueStore, OutboxMessage } from '@authmodules/contracts/extensions'
import type { Result } from '@authmodules/contracts/result'
import type { TransactionContext } from '@authmodules/contracts/transaction'
import type { OutboxEffectsDispatcherOptions } from '../dispatcher/types.ts'
import { snapshotPersistableDeliveryMessage } from '../delivery/validation.ts'
import { outboxSecretPurpose } from '../delivery/outbox-secret-purpose.ts'
import { normalizeDispatchContext } from '../shared/context.ts'
import { clonePublicData, isJsonObject, isSafeText } from '../shared/json.ts'

type IdGenerator = OutboxEffectsDispatcherOptions['idGenerator']
const successKeys = new Set(['ok', 'value'])
const failureKeys = new Set(['error', 'ok'])
const storeFailureKeys = new Set(['component', 'details', 'reason', 'type'])
const outboxStatuses = new Set(['pending', 'claimed', 'dispatched', 'failed', 'dead'])
const outboxMessageKeys = new Set([
  'attempts',
  'availableAt',
  'context',
  'createdAt',
  'dispatchPolicy',
  'expiresAt',
  'idempotencyKey',
  'lastFailureReason',
  'maxAttempts',
  'message',
  'messageId',
  'secretPurpose',
  'status',
  'tenantId',
  'type',
  'updatedAt'
])

export function safeGenerateId(idGenerator: IdGenerator, input: Parameters<IdGenerator>[0]): string | undefined {
  try {
    return idGenerator(input)
  } catch {
    return undefined
  }
}

export async function safeEnqueueBatch(
  store: OutboxEnqueueStore,
  input: { readonly messages: readonly OutboxMessage[] },
  tx?: TransactionContext
): Promise<Result<readonly OutboxMessage[], StoreFailure>> {
  try {
    const result = await store.enqueueBatch(input, tx)
    if (!isRecord(result)) return storeUnavailable()
    const ok = result.ok
    if (ok === true && hasOnlyKeys(result, successKeys)) {
      const value = result.value
      if (Array.isArray(value) && value.length === input.messages.length) {
        const messages = value.map((message, index) => (
          snapshotAcknowledgedMessage(message, input.messages[index])
        ))
        if (messages.every((message) => message !== undefined)) {
          return { ok: true, value: messages as readonly OutboxMessage[] }
        }
      }
    }
    if (ok === false && hasOnlyKeys(result, failureKeys)) {
      const error = snapshotStoreFailure(result.error)
      if (error) return { ok: false, error }
    }
    return storeUnavailable()
  } catch {
    return storeUnavailable()
  }
}

function storeUnavailable(): Result<never, StoreFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'store',
      reason: 'STORE_UNAVAILABLE'
    }
  }
}

function snapshotStoreFailure(value: unknown): StoreFailure | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, storeFailureKeys)) return undefined
  const type = value.type
  const component = value.component
  const reason = value.reason
  const details = value.details
  if (type !== 'component.failure'
    || component !== 'store'
    || !isSafeText(reason, 512)
    || reason.length === 0) return undefined
  if (details === undefined) return { type, component, reason }
  try {
    const snapshot = structuredClone(details)
    if (!isJsonObject(snapshot)) return undefined
    return { type, component, reason, details: clonePublicData(snapshot) }
  } catch {
    return undefined
  }
}

function snapshotAcknowledgedMessage(
  value: unknown,
  expected: OutboxMessage | undefined
): OutboxMessage | undefined {
  if (!expected || !isRecord(value) || !hasOnlyKeys(value, outboxMessageKeys)) return undefined
  const tenantId = value.tenantId
  const messageId = value.messageId
  const contextSource = value.context
  const secretPurpose = value.secretPurpose
  const type = value.type
  const messageSource = value.message
  const dispatchPolicy = value.dispatchPolicy
  const status = value.status
  const attempts = value.attempts
  const maxAttempts = value.maxAttempts
  const lastFailureReason = value.lastFailureReason
  const idempotencyKey = value.idempotencyKey
  const expiresAtSource = value.expiresAt
  const availableAtSource = value.availableAt
  const createdAtSource = value.createdAt
  const updatedAtSource = value.updatedAt
  const expiresAt = expiresAtSource === undefined ? undefined : snapshotDate(expiresAtSource)
  const availableAt = snapshotDate(availableAtSource)
  const createdAt = snapshotDate(createdAtSource)
  const updatedAt = snapshotDate(updatedAtSource)
  if (tenantId !== expected.tenantId
    || idempotencyKey !== expected.idempotencyKey
    || (idempotencyKey === undefined && messageId !== expected.messageId)
    || !isSafeText(messageId, 512)
    || messageId.length === 0
    || secretPurpose !== outboxSecretPurpose(expected.tenantId, messageId)
    || type !== 'delivery'
    || (dispatchPolicy !== 'required' && dispatchPolicy !== 'best-effort')
    || !isOutboxStatus(status)
    || !isNonNegativeInteger(attempts)
    || !isPositiveInteger(maxAttempts)
    || attempts > maxAttempts
    || !isConsistentStatusAttempt(status, attempts, maxAttempts)
    || (lastFailureReason !== undefined
      && (!isSafeText(lastFailureReason, 512) || lastFailureReason.length === 0))
    || (expiresAtSource !== undefined && !expiresAt)
    || !availableAt
    || !createdAt
    || !updatedAt) return undefined
  const context = normalizeDispatchContext(contextSource)
  const message = snapshotPersistableDeliveryMessage(messageSource)
  if (!context || context.tenantId !== tenantId || !message) return undefined
  return {
    tenantId,
    messageId,
    context,
    secretPurpose,
    type: 'delivery',
    message,
    dispatchPolicy,
    status: status as OutboxMessage['status'],
    attempts,
    maxAttempts,
    ...(lastFailureReason === undefined ? {} : { lastFailureReason }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    availableAt,
    createdAt,
    updatedAt
  } as OutboxMessage
}

function snapshotDate(value: unknown): Date | undefined {
  if (!(value instanceof Date)) return undefined
  const timestamp = Date.prototype.getTime.call(value)
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isConsistentStatusAttempt(
  status: OutboxMessage['status'],
  attempts: number,
  maxAttempts: number
): boolean {
  if (status === 'pending') return attempts === 0
  if (status === 'failed') return attempts > 0 && attempts < maxAttempts
  return status === 'claimed' || status === 'dispatched' || status === 'dead'
}

function isOutboxStatus(value: unknown): value is OutboxMessage['status'] {
  return typeof value === 'string' && outboxStatuses.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
