import type { OutboxMessage, OutboxStore } from '@authmodules/contracts/extensions'
import { isSafeStoredText, isValidDate } from '../shared/validation.ts'

const outboxKeys = new Set([
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
const secretDescriptorTypes = new Set<unknown>(['raw-secret', 'protected-value', 'sealed-secret'])

type ClaimInput = Parameters<OutboxStore['claimBatch']>[0]
type MarkDispatchedInput = Parameters<OutboxStore['markDispatched']>[0]
type MarkFailedInput = Parameters<OutboxStore['markFailed']>[0]
type RenewLeaseInput = Parameters<OutboxStore['renewLease']>[0]
type CleanupTerminalInput = Parameters<OutboxStore['cleanupTerminal']>[0]

export function isPersistableOutboxMessage(value: unknown, newMessage: boolean): value is OutboxMessage {
  if (!isRecord(value)
    || !hasOnlyKeys(value, outboxKeys)
    || !isSafeStoredText(value.tenantId, 512, true)
    || !isSafeStoredText(value.messageId, 512, true)
    || !isDispatchContext(value.context, value.tenantId)
    || !isSafeStoredText(value.secretPurpose, 4096, true)
    || value.secretPurpose !== outboxSecretPurpose(value.tenantId, value.messageId)
    || value.type !== 'delivery'
    || !isPersistableDeliveryMessage(value.message)
    || (value.dispatchPolicy !== 'required' && value.dispatchPolicy !== 'best-effort')
    || !isOutboxStatus(value.status)
    || !isNonNegativeInteger(value.attempts)
    || !isPositiveInteger(value.maxAttempts)
    || value.attempts > value.maxAttempts
    || (value.lastFailureReason !== undefined && !isSafeStoredText(value.lastFailureReason, 512, true))
    || (value.idempotencyKey === undefined
      ? value.dispatchPolicy === 'required'
      : !isSafeStoredText(value.idempotencyKey, 512, true))
    || (value.expiresAt !== undefined && !isValidDate(value.expiresAt))
    || !isValidDate(value.availableAt)
    || !isValidDate(value.createdAt)
    || !isValidDate(value.updatedAt)) return false
  return !newMessage || (
    value.status === 'pending'
    && value.attempts === 0
    && value.lastFailureReason === undefined
  )
}

function outboxSecretPurpose(tenantId: string, messageId: string): string {
  return JSON.stringify(['authmodules.outbox.delivery', tenantId, messageId])
}

export function isOutboxClaimInput(value: unknown): value is ClaimInput {
  return isRecord(value)
    && isValidDate(value.now)
    && isPositiveInteger(value.limit)
    && value.limit <= 1000
    && isSafeStoredText(value.workerId, 512, true)
    && isPositiveInteger(value.leaseSeconds)
    && value.leaseSeconds <= 86400
    && (value.tenantId === undefined || isSafeStoredText(value.tenantId, 512, true))
}

export function isOutboxRenewLeaseInput(value: unknown): value is RenewLeaseInput {
  return isLeaseMutationInput(value)
    && isRecord(value)
    && isPositiveInteger(value.leaseSeconds)
    && value.leaseSeconds <= 86400
}

export function isOutboxMarkDispatchedInput(value: unknown): value is MarkDispatchedInput {
  return isLeaseMutationInput(value)
}

export function isOutboxMarkFailedInput(value: unknown): value is MarkFailedInput {
  return isRecord(value)
    && isLeaseMutationInput(value)
    && isSafeStoredText(value.reason, 512, true)
    && (value.retryAt === undefined || isValidDate(value.retryAt))
    && (value.terminal === undefined || typeof value.terminal === 'boolean')
}

export function isOutboxCleanupTerminalInput(value: unknown): value is CleanupTerminalInput {
  return isRecord(value)
    && isValidDate(value.before)
    && isPositiveInteger(value.limit)
    && value.limit <= 1000
    && Array.isArray(value.statuses)
    && value.statuses.length > 0
    && value.statuses.length <= 2
    && Object.keys(value.statuses).length === value.statuses.length
    && new Set(value.statuses).size === value.statuses.length
    && value.statuses.every((status) => status === 'dispatched' || status === 'dead')
    && (value.tenantId === undefined || isSafeStoredText(value.tenantId, 512, true))
}

function isLeaseMutationInput(value: unknown): boolean {
  return isRecord(value)
    && isSafeStoredText(value.tenantId, 512, true)
    && isSafeStoredText(value.messageId, 512, true)
    && isSafeStoredText(value.workerId, 512, true)
    && isSafeStoredText(value.leaseId, 512, true)
    && isValidDate(value.now)
}

function isDispatchContext(value: unknown, tenantId: string): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(['locale', 'metadata', 'requestId', 'tenantId']))
    || value.tenantId !== tenantId) return false
  return (value.requestId === undefined || isSafeStoredText(value.requestId, 512, true))
    && (value.locale === undefined || isSafeStoredText(value.locale, 128, true))
    && (value.metadata === undefined || isJsonObject(value.metadata))
}

function isPersistableDeliveryMessage(value: unknown): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(['data', 'locale', 'metadata', 'templateId', 'to']))
    || !isRecord(value.to)
    || !hasOnlyKeys(value.to, new Set(['channel', 'display', 'target']))
    || !isSafeStoredText(value.to.channel, 64, true)
    || !isSafeStoredText(value.to.target, 2048, true)
    || (value.to.display !== undefined && !isSafeStoredText(value.to.display, 512, false))
    || !isSafeStoredText(value.templateId, 256, true)
    || (value.locale !== undefined && !isSafeStoredText(value.locale, 128, true))
    || (value.metadata !== undefined && !isJsonObject(value.metadata))) return false
  return value.data === undefined || isPersistableDeliveryData(value.data)
}

function isPersistableDeliveryData(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > 1000) return false
  const state: JsonState = { visiting: new Set(), nodes: 0, characters: 0 }
  return Object.entries(value).every(([key, item]) => (
    consumeText(key, 512, state, true)
    && (isSealedSecret(item)
      ? consumeSealedSecret(item, state)
      : isJsonValue(item, 0, state))
  ))
}

function consumeSealedSecret(
  value: Record<string, unknown> & { revealCiphertextForPersistence(): string },
  state: JsonState
): boolean {
  try {
    return consumeText(value.revealCiphertextForPersistence(), 1_000_000, state, true)
  } catch {
    return false
  }
}

function isSealedSecret(value: unknown): value is Record<string, unknown> & {
  revealCiphertextForPersistence(): string
} {
  return isRecord(value)
    && value.type === 'sealed-secret'
    && isSafeStoredText(value.algorithm, 256, true)
    && isSafeStoredText(value.keyId, 512, true)
    && typeof value.redacted === 'string'
    && typeof value.revealCiphertextForPersistence === 'function'
    && typeof value.toJSON === 'function'
    && (value.expiresAt === undefined || isValidDate(value.expiresAt))
    && !('reveal' in value)
    && !('revealForPersistence' in value)
}

function isJsonObject(value: unknown): boolean {
  return isPlainObject(value) && isJsonValue(value)
}

function isJsonValue(
  value: unknown,
  depth = 0,
  state: JsonState = { visiting: new Set(), nodes: 0, characters: 0 }
): boolean {
  state.nodes += 1
  if (state.nodes > 1000) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return consumeText(value, 65536, state)
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || value instanceof Date || depth >= 16 || state.visiting.has(value)) return false
  if (isSecretDescriptor(value)) return false
  if ('reveal' in value || 'revealForPersistence' in value || 'revealCiphertextForPersistence' in value) return false
  state.visiting.add(value)
  const valid = Array.isArray(value)
    ? isDenseJsonArray(value) && value.every((item) => isJsonValue(item, depth + 1, state))
    : isPlainObject(value) && Object.entries(value).every(([key, item]) => (
      consumeText(key, 512, state, true) && isJsonValue(item, depth + 1, state)
    ))
  state.visiting.delete(value)
  return valid
}

function consumeText(
  value: unknown,
  maxLength: number,
  state: JsonState,
  requireNonEmpty = false
): value is string {
  if (!isSafeStoredText(value, maxLength, requireNonEmpty)) return false
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

function isOutboxStatus(value: unknown): value is OutboxMessage['status'] {
  return value === 'pending'
    || value === 'claimed'
    || value === 'dispatched'
    || value === 'failed'
    || value === 'dead'
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSecretDescriptor(value: object): boolean {
  return !Array.isArray(value) && 'type' in value && secretDescriptorTypes.has(value.type)
}

type JsonState = {
  readonly visiting: Set<object>
  nodes: number
  characters: number
}
