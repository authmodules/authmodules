import type { LeasedOutboxMessage } from '@authmodules/contracts/extensions'
import type { OutboxWorker } from './types.ts'
import {
  isPersistedDeliveryMessage,
  snapshotPersistedDeliveryMessage
} from '../delivery/validation.ts'
import { outboxSecretPurpose } from '../delivery/outbox-secret-purpose.ts'
import { normalizeDispatchContext } from '../shared/context.ts'
import { isSafeText } from '../shared/json.ts'

type RunInput = Parameters<OutboxWorker['runOnce']>[0]

const leaseKeys = new Set(['leaseId', 'leaseUntil', 'workerId'])
const messageKeys = new Set([
  'attempts',
  'availableAt',
  'context',
  'createdAt',
  'dispatchPolicy',
  'expiresAt',
  'idempotencyKey',
  'lastFailureReason',
  'lease',
  'maxAttempts',
  'message',
  'messageId',
  'secretPurpose',
  'status',
  'tenantId',
  'type',
  'updatedAt'
])
const runInputKeys = new Set(['limit', 'now', 'tenantId'])

export function isRunInput(input: unknown): input is RunInput {
  return snapshotRunInput(input) !== undefined
}

export function snapshotRunInput(input: unknown): RunInput | undefined {
  try {
    if (!isRecord(input) || !hasOnlyKeys(input, runInputKeys)) return undefined
    const nowSource = input.now
    const tenantId = input.tenantId
    const limit = input.limit
    const timestamp = dateTimestamp(nowSource)
    if (timestamp === undefined
      || (tenantId !== undefined && (!isSafeText(tenantId, 512) || tenantId.length === 0))
      || (limit !== undefined
        && (typeof limit !== 'number'
          || !Number.isSafeInteger(limit)
          || limit <= 0
          || limit > 1000))) return undefined
    return {
      now: new Date(timestamp),
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(limit === undefined ? {} : { limit })
    }
  } catch {
    return undefined
  }
}

export function isClaimedMessage(message: unknown): message is LeasedOutboxMessage {
  return isRecord(message)
    && hasOnlyKeys(message, messageKeys)
    &&
    isSafeText(message.tenantId, 512) &&
    message.tenantId.length > 0 &&
    isSafeText(message.messageId, 512) &&
    message.messageId.length > 0 &&
    isRecord(message.context) &&
    message.context.tenantId === message.tenantId &&
    normalizeDispatchContext(message.context) !== null &&
    isSafeText(message.secretPurpose, 4096) &&
    message.secretPurpose.length > 0 &&
    message.secretPurpose === outboxSecretPurpose(message.tenantId, message.messageId) &&
    message.type === 'delivery' &&
    isPersistedDeliveryMessage(message.message) &&
    (message.dispatchPolicy === 'required' || message.dispatchPolicy === 'best-effort') &&
    message.status === 'claimed' &&
    isNonNegativeInteger(message.attempts) &&
    isPositiveInteger(message.maxAttempts) &&
    message.attempts < message.maxAttempts &&
    (message.lastFailureReason === undefined
      || (isSafeText(message.lastFailureReason, 512) && message.lastFailureReason.length > 0)) &&
    isRecord(message.lease) &&
    hasOnlyKeys(message.lease, leaseKeys) &&
    isSafeText(message.lease.workerId, 512) &&
    message.lease.workerId.length > 0 &&
    isSafeText(message.lease.leaseId, 512) &&
    message.lease.leaseId.length > 0 &&
    isValidDate(message.lease.leaseUntil)
    && (message.idempotencyKey === undefined
      ? message.dispatchPolicy === 'best-effort'
      : isSafeText(message.idempotencyKey, 512) && message.idempotencyKey.length > 0)
    && (message.expiresAt === undefined
      || isValidDate(message.expiresAt))
    && isValidDate(message.availableAt)
    && isValidDate(message.createdAt)
    && isValidDate(message.updatedAt)
}

export function snapshotClaimedMessage(message: unknown): LeasedOutboxMessage | undefined {
  try {
    if (!isRecord(message)
      || !hasOnlyKeys(message, messageKeys)) return undefined
    const leaseSource = message.lease
    if (!isRecord(leaseSource)) return undefined
    const contextSource = message.context
    const deliveryMessageSource = message.message
    const context = normalizeDispatchContext(contextSource)
    const deliveryMessage = snapshotPersistedDeliveryMessage(deliveryMessageSource)
    const leaseId = leaseSource.leaseId
    const workerId = leaseSource.workerId
    const leaseUntil = cloneDate(leaseSource.leaseUntil)
    const snapshot = {
      tenantId: message.tenantId,
      messageId: message.messageId,
      context,
      secretPurpose: message.secretPurpose,
      type: message.type,
      message: deliveryMessage,
      status: message.status,
      attempts: message.attempts,
      maxAttempts: message.maxAttempts,
      dispatchPolicy: message.dispatchPolicy,
      idempotencyKey: message.idempotencyKey,
      lastFailureReason: message.lastFailureReason,
      expiresAt: cloneDate(message.expiresAt),
      availableAt: cloneDate(message.availableAt),
      createdAt: cloneDate(message.createdAt),
      updatedAt: cloneDate(message.updatedAt),
      lease: {
        leaseId,
        workerId,
        leaseUntil
      }
    }
    return isClaimedMessage(snapshot) ? snapshot : undefined
  } catch {
    return undefined
  }
}

function cloneDate(value: unknown): unknown {
  const timestamp = dateTimestamp(value)
  return timestamp === undefined ? value : new Date(timestamp)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isValidDate(value: unknown): value is Date {
  return dateTimestamp(value) !== undefined
}

function dateTimestamp(value: unknown): number | undefined {
  if (!(value instanceof Date)) return undefined
  try {
    const timestamp = Date.prototype.getTime.call(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  } catch {
    return undefined
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
