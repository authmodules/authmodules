import type { StoreFailure } from '@authmodules/contracts/errors'
import type { OutboxLease, OutboxWorkerStore } from '@authmodules/contracts/extensions'
import type { Result } from '@authmodules/contracts/result'
import {
  type OutboxWorker,
  type OutboxWorkerOptions,
  type OutboxWorkerRunInput,
  type OutboxWorkerRunResult
} from './types.ts'
import { snapshotClaimedMessage, snapshotRunInput } from './validation.ts'
import { safeSend, safeStoreCall } from './operations.ts'
import { unsealDeliveryMessage } from '../delivery/unseal.ts'
import { normalizeDispatchContext } from '../shared/context.ts'
import { isSafeText } from '../shared/json.ts'
import { workerStoreErr } from '../shared/result.ts'

export function createOutboxWorker(options: OutboxWorkerOptions): OutboxWorker

export function createOutboxWorker(options?: OutboxWorkerOptions): OutboxWorker {
  if (!options) throw new TypeError('Outbox worker options are required')
  const config: Partial<OutboxWorkerOptions> = options
  const store = config.store
  const transport = config.transport
  const sealer = config.sealer
  const workerId = config.workerId
  const leaseSeconds = config.leaseSeconds ?? 30
  const limit = config.limit ?? 10
  const retryDelaySeconds = config.retryDelaySeconds ?? 60
  if (!store
    || typeof store.claimBatch !== 'function'
    || typeof store.renewLease !== 'function') throw new TypeError('Outbox store is required')
  if (!transport || typeof transport.send !== 'function') throw new TypeError('Delivery transport is required')
  if (!sealer || typeof sealer.unseal !== 'function') throw new TypeError('Secret sealer is required')
  if (!isSafeText(workerId, 512) || workerId.length === 0) throw new TypeError('workerId is required')
  for (const [name, value] of Object.entries({ leaseSeconds, limit, retryDelaySeconds })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  }
  if (leaseSeconds > 86400) throw new TypeError('leaseSeconds must not exceed 86400')
  if (limit > 1000) throw new TypeError('limit must not exceed 1000')
  if (retryDelaySeconds > 31_536_000) throw new TypeError('retryDelaySeconds must not exceed 31536000')

  return {
    async runOnce(
      input: OutboxWorkerRunInput
    ): Promise<Result<OutboxWorkerRunResult, StoreFailure>> {
      const runInput = snapshotRunInput(input)
      if (!runInput) return workerStoreErr('OUTBOX_INVALID_INPUT')
      const initialTime = Date.prototype.getTime.call(runInput.now)
      const startedAt = Date.now()
      let previousTime = initialTime
      const currentTime = (): Date => {
        const candidate = initialTime + Math.max(0, Date.now() - startedAt)
        previousTime = Math.max(previousTime, Math.min(candidate, 8_640_000_000_000_000))
        return new Date(previousTime)
      }
      const requestedLimit = runInput.limit ?? limit
      let claimedCount = 0
      let dispatched = 0
      let failed = 0
      let firstStoreFailure: Result<never, StoreFailure> | undefined
      const seenClaims = new Set<string>()
      const rememberFailure = (failure: Result<never, StoreFailure>): void => {
        firstStoreFailure ??= failure
      }
      for (let index = 0; index < requestedLimit; index += 1) {
        const claimNow = currentTime()
        const claimed: Result<unknown, StoreFailure> = await safeStoreCall<unknown>(
          (): ReturnType<OutboxWorkerStore['claimBatch']> => store.claimBatch({
          now: claimNow,
          limit: 1,
          workerId,
          leaseSeconds,
          tenantId: runInput.tenantId
          })
        )
        if (!claimed.ok) {
          rememberFailure(claimed)
          break
        }
        if (!Array.isArray(claimed.value) || claimed.value.length > 1) {
          rememberFailure(workerStoreErr('OUTBOX_RECORD_INVALID'))
          break
        }
        const claimedMessage: unknown = claimed.value[0]
        if (!claimedMessage) break
        claimedCount += 1
        const message = snapshotClaimedMessage(claimedMessage)
        if (!message) {
          rememberFailure(workerStoreErr('OUTBOX_RECORD_INVALID'))
          continue
        }
        if (runInput.tenantId !== undefined && message.tenantId !== runInput.tenantId) {
          rememberFailure(workerStoreErr('OUTBOX_RECORD_INVALID'))
          continue
        }
        const claimKey = JSON.stringify([message.tenantId, message.messageId, message.lease.leaseId])
        if (seenClaims.has(claimKey)) {
          rememberFailure(workerStoreErr('OUTBOX_RECORD_INVALID'))
          continue
        }
        seenClaims.add(claimKey)
        const context = normalizeDispatchContext(message.context)
        if (!context) {
          rememberFailure(workerStoreErr('OUTBOX_RECORD_INVALID'))
          continue
        }
        let lease = message.lease
        const processingNow = currentTime()
        if (lease.workerId !== workerId || lease.leaseUntil <= processingNow) {
          rememberFailure(workerStoreErr('OUTBOX_LEASE_CONFLICT'))
          continue
        }
        const processingLease = await renewMessageLease(store, {
          tenantId: message.tenantId,
          messageId: message.messageId,
          workerId,
          leaseId: lease.leaseId,
          now: processingNow,
          leaseSeconds
        })
        if (!processingLease.ok) {
          rememberFailure(processingLease)
          continue
        }
        lease = processingLease.value
        const unsealNow = currentTime()
        if (message.expiresAt && message.expiresAt <= unsealNow) {
          failed += 1
          const marked = await safeStoreCall(() => store.markFailed({
            tenantId: message.tenantId,
            messageId: message.messageId,
            workerId,
            leaseId: lease.leaseId,
            now: unsealNow,
            reason: 'DELIVERY_FAILED',
            terminal: true
          }))
          if (!marked.ok) rememberFailure(marked)
          continue
        }
        if (lease.leaseUntil <= unsealNow) {
          rememberFailure(workerStoreErr('OUTBOX_LEASE_CONFLICT'))
          continue
        }
        const prepared = await unsealDeliveryMessage(sealer, message, unsealNow)
        if (!prepared.ok) {
          failed += 1
          const failedAt = currentTime()
          const terminal = Boolean(message.expiresAt && message.expiresAt <= failedAt)
          const marked = await safeStoreCall(() => store.markFailed({
            tenantId: message.tenantId,
            messageId: message.messageId,
            workerId,
            leaseId: lease.leaseId,
            now: failedAt,
            reason: 'DELIVERY_FAILED',
            terminal,
            retryAt: terminal ? undefined : new Date(failedAt.getTime() + retryDelaySeconds * 1000)
          }))
          if (!marked.ok) rememberFailure(marked)
          continue
        }
        const deliveryNow = currentTime()
        if (message.expiresAt && message.expiresAt <= deliveryNow) {
          failed += 1
          const marked = await safeStoreCall(() => store.markFailed({
            tenantId: message.tenantId,
            messageId: message.messageId,
            workerId,
            leaseId: lease.leaseId,
            now: deliveryNow,
            reason: 'DELIVERY_FAILED',
            terminal: true
          }))
          if (!marked.ok) rememberFailure(marked)
          continue
        }
        const deliveryLease = await renewMessageLease(store, {
          tenantId: message.tenantId,
          messageId: message.messageId,
          workerId,
          leaseId: lease.leaseId,
          now: deliveryNow,
          leaseSeconds
        })
        if (!deliveryLease.ok) {
          rememberFailure(deliveryLease)
          continue
        }
        lease = deliveryLease.value
        const sendNow = currentTime()
        if (message.expiresAt && message.expiresAt <= sendNow) {
          failed += 1
          const marked = await safeStoreCall(() => store.markFailed({
            tenantId: message.tenantId,
            messageId: message.messageId,
            workerId,
            leaseId: lease.leaseId,
            now: sendNow,
            reason: 'DELIVERY_FAILED',
            terminal: true
          }))
          if (!marked.ok) rememberFailure(marked)
          continue
        }
        if (lease.leaseUntil <= sendNow) {
          rememberFailure(workerStoreErr('OUTBOX_LEASE_CONFLICT'))
          continue
        }
        const result = await safeSend(transport, {
          context,
          message: prepared.value,
          idempotencyKey: message.idempotencyKey ?? message.messageId,
          ...(message.expiresAt === undefined ? {} : { expiresAt: message.expiresAt }),
          now: sendNow
        })

        if (result.ok) {
          const completedAt = currentTime()
          const marked = await safeStoreCall(() => store.markDispatched({
            tenantId: message.tenantId,
            messageId: message.messageId,
            workerId,
            leaseId: lease.leaseId,
            now: completedAt
          }))
          if (!marked.ok) {
            rememberFailure(marked)
          } else {
            dispatched += 1
          }
        } else {
          failed += 1
          const failedAt = currentTime()
          const marked = await safeStoreCall(() => store.markFailed({
            tenantId: message.tenantId,
            messageId: message.messageId,
            workerId,
            leaseId: lease.leaseId,
            now: failedAt,
            reason: result.error.reason,
            retryAt: new Date(failedAt.getTime() + retryDelaySeconds * 1000)
          }))
          if (!marked.ok) rememberFailure(marked)
        }
      }

      if (firstStoreFailure) return firstStoreFailure
      return {
        ok: true,
        value: {
          claimed: claimedCount,
          dispatched,
          failed
        }
      }
    }
  }
}

async function renewMessageLease(
  store: OutboxWorkerStore,
  input: Parameters<OutboxWorkerStore['renewLease']>[0]
): Promise<Result<OutboxLease, StoreFailure>> {
  const leaseId = input.leaseId
  const workerId = input.workerId
  const now = Date.prototype.getTime.call(input.now)
  const renewed = await safeStoreCall(() => store.renewLease({
    ...input,
    now: new Date(now)
  }))
  if (!renewed.ok) return renewed
  const lease = snapshotOutboxLease(renewed.value, { leaseId, workerId, now })
  return lease
    ? { ok: true, value: lease }
    : workerStoreErr('OUTBOX_RECORD_INVALID')
}

function snapshotOutboxLease(
  value: unknown,
  expected: Readonly<{ leaseId: string, workerId: string, now: number }>
): OutboxLease | null {
  try {
    if (!value
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.keys(value).length !== 3
      || !('leaseId' in value)
      || !('workerId' in value)
      || !('leaseUntil' in value)) return null
    const leaseId = value.leaseId
    const workerId = value.workerId
    const leaseUntilSource = value.leaseUntil
    if (leaseId !== expected.leaseId
      || workerId !== expected.workerId
      || !(leaseUntilSource instanceof Date)) return null
    const leaseUntil = Date.prototype.getTime.call(leaseUntilSource)
    if (!Number.isFinite(leaseUntil) || leaseUntil <= expected.now) return null
    return Object.freeze({
      leaseId,
      workerId,
      leaseUntil: new Date(leaseUntil)
    })
  } catch {
    return null
  }
}
