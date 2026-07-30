import type { LeasedOutboxMessage, OutboxLease, OutboxMessage, OutboxStore } from '@authmodules/contracts/extensions'
import type { TransactionContext } from '@authmodules/contracts/transaction'
import { err, ok } from '../shared/result.ts'
import { storeFailure } from './failure.ts'
import { cloneRecord } from './state.ts'
import {
  isNewPersistableOutboxMessage,
  isOutboxClaimInput,
  isOutboxCleanupTerminalInput,
  isOutboxMarkDispatchedInput,
  isOutboxMarkFailedInput,
  isOutboxRenewLeaseInput,
  outboxMessageCharacterCount
} from './outbox-validation.ts'

type StoredOutboxMessage = OutboxMessage & { readonly lease?: OutboxLease }

export type MemoryOutboxState = {
  readonly messages: Map<string, StoredOutboxMessage>
  readonly idempotencyKeys: Map<string, string>
  leaseSequence: number
}

export type MemoryOutboxStore = OutboxStore & {
  readonly __unsafeMessages: Map<string, StoredOutboxMessage>
  readonly __unsafeIdempotencyKeys: Map<string, string>
}

export function createMemoryOutboxStore(): MemoryOutboxStore

export function createMemoryOutboxStore(): MemoryOutboxStore {
  return createMemoryOutboxStoreForState(createEmptyMemoryOutboxState())
}

export function createEmptyMemoryOutboxState(): MemoryOutboxState {
  return {
    messages: new Map(),
    idempotencyKeys: new Map(),
    leaseSequence: 0
  }
}

export function createMemoryOutboxStoreForState(state: MemoryOutboxState): MemoryOutboxStore {

  async function enqueueBatch(
    input: Parameters<OutboxStore['enqueueBatch']>[0],
    tx?: Parameters<OutboxStore['enqueueBatch']>[1]
  ): ReturnType<OutboxStore['enqueueBatch']> {
    const current = memoryOutboxStateFor(state, tx)
    if (!current || !Array.isArray(input?.messages) || input.messages.length > 1000) {
      return err(storeFailure('OUTBOX_ENQUEUE_FAILED'))
    }
    const messages: OutboxMessage[] = []
    try {
      for (const message of input.messages) {
        const snapshot = cloneRecord(message)
        if (!isNewPersistableOutboxMessage(snapshot)) {
          return err(storeFailure('OUTBOX_ENQUEUE_FAILED'))
        }
        messages.push(snapshot)
      }
    } catch {
      return err(storeFailure('OUTBOX_ENQUEUE_FAILED'))
    }
    let payloadCharacters = 0
    for (const message of messages) {
      payloadCharacters += outboxMessageCharacterCount(message)
      if (payloadCharacters > 10_000_000) {
        return err(storeFailure('OUTBOX_ENQUEUE_FAILED'))
      }
    }
    const seenMessageIds = new Set<string>()
    const seenIdempotencyKeys = new Set<string>()
    const stagedMessages: Array<{ readonly key: string; readonly message: OutboxMessage }> = []
    const stagedIdempotencyKeys: Array<{ readonly key: string; readonly messageId: string }> = []
    const result: OutboxMessage[] = []

    for (const message of messages) {
      const key = outboxKey(message.tenantId, message.messageId)
      if (seenMessageIds.has(key)) return err(storeFailure('OUTBOX_ENQUEUE_FAILED'))
      seenMessageIds.add(key)

      if (message.idempotencyKey !== undefined) {
        const idempotencyKey = outboxKey(message.tenantId, message.idempotencyKey)
        if (seenIdempotencyKeys.has(idempotencyKey)) return err(storeFailure('OUTBOX_ENQUEUE_FAILED'))
        seenIdempotencyKeys.add(idempotencyKey)
        const existingId = current.idempotencyKeys.get(idempotencyKey)
        if (existingId) {
          const existing = current.messages.get(outboxKey(message.tenantId, existingId))
          if (!existing) return err(storeFailure('OUTBOX_ENQUEUE_FAILED'))
          const { lease: _lease, ...existingMessage } = cloneRecord(existing)
          result.push(existingMessage)
          continue
        }
        stagedIdempotencyKeys.push({ key: idempotencyKey, messageId: message.messageId })
      }

      if (current.messages.has(key)) return err(storeFailure('OUTBOX_ENQUEUE_FAILED'))
      stagedMessages.push({ key, message })
      result.push(cloneRecord(message))
    }

    for (const { key, messageId } of stagedIdempotencyKeys) current.idempotencyKeys.set(key, messageId)
    for (const { key, message } of stagedMessages) current.messages.set(key, cloneRecord(message))
    return ok(result)
  }

  return {
    async enqueue(input, tx) {
      if (!input || !('message' in input)) return err(storeFailure('OUTBOX_ENQUEUE_FAILED'))
      const result = await enqueueBatch({ messages: [input.message] }, tx)
      return result.ok ? ok(result.value[0]) : result
    },
    enqueueBatch,
    async claimBatch(input) {
      if (!isOutboxClaimInput(input)) {
        return err(storeFailure('OUTBOX_LEASE_CONFLICT'))
      }
      const claimed: LeasedOutboxMessage[] = []
      for (const [key, storedMessage] of state.messages) {
        if (claimed.length >= input.limit) break
        let message = storedMessage
        if (input.tenantId && message.tenantId !== input.tenantId) continue
        if (message.expiresAt && message.expiresAt <= input.now) {
          state.messages.set(key, {
            ...message,
            status: 'dead',
            lease: undefined,
            updatedAt: cloneRecord(input.now)
          })
          continue
        }
        const reclaimable = message.status === 'claimed'
          && message.lease !== undefined
          && message.lease.leaseUntil <= input.now
        if (!['pending', 'failed'].includes(message.status) && !reclaimable) continue
        if (reclaimable) {
          const attempts = message.attempts + 1
          if (attempts >= message.maxAttempts) {
            state.messages.set(key, {
              ...message,
              attempts,
              status: 'dead',
              lastFailureReason: 'OUTBOX_LEASE_CONFLICT',
              lease: undefined,
              updatedAt: cloneRecord(input.now)
            })
            continue
          }
          message = {
            ...message,
            attempts,
            status: 'failed',
            lastFailureReason: 'OUTBOX_LEASE_CONFLICT',
            lease: undefined,
            availableAt: cloneRecord(input.now),
            updatedAt: cloneRecord(input.now)
          }
        }
        if (message.availableAt > input.now || message.attempts >= message.maxAttempts) continue
        state.leaseSequence += 1
        const leased: LeasedOutboxMessage = {
          ...message,
          status: 'claimed',
          lease: {
            leaseId: `lease_${state.leaseSequence}`,
            workerId: input.workerId,
            leaseUntil: new Date(input.now.getTime() + input.leaseSeconds * 1000)
          },
          updatedAt: cloneRecord(input.now)
        }
        state.messages.set(key, cloneRecord(leased))
        claimed.push(cloneRecord(leased))
      }
      return ok(claimed)
    },
    async renewLease(input) {
      if (!isOutboxRenewLeaseInput(input)) {
        return err(storeFailure('OUTBOX_LEASE_CONFLICT'))
      }
      const key = outboxKey(input.tenantId, input.messageId)
      const current = state.messages.get(key)
      if (!validOutboxLease(current, input)) return err(storeFailure('OUTBOX_LEASE_CONFLICT'))
      const lease = {
        leaseId: input.leaseId,
        workerId: input.workerId,
        leaseUntil: new Date(input.now.getTime() + input.leaseSeconds * 1000)
      }
      state.messages.set(key, { ...current, lease, updatedAt: cloneRecord(input.now) })
      return ok(cloneRecord(lease))
    },
    async markDispatched(input) {
      if (!isOutboxMarkDispatchedInput(input)) {
        return err(storeFailure('OUTBOX_LEASE_CONFLICT'))
      }
      const key = outboxKey(input.tenantId, input.messageId)
      const current = state.messages.get(key)
      if (!validOutboxLease(current, input)) return err(storeFailure('OUTBOX_LEASE_CONFLICT'))
      state.messages.set(key, {
        ...current,
        status: 'dispatched',
        lastFailureReason: undefined,
        lease: undefined,
        updatedAt: cloneRecord(input.now)
      })
      return ok(undefined)
    },
    async markFailed(input) {
      if (!isOutboxMarkFailedInput(input)) {
        return err(storeFailure('OUTBOX_LEASE_CONFLICT'))
      }
      const key = outboxKey(input.tenantId, input.messageId)
      const current = state.messages.get(key)
      if (!validOutboxLease(current, input)) return err(storeFailure('OUTBOX_LEASE_CONFLICT'))
      const attempts = current.attempts + 1
      state.messages.set(key, {
        ...current,
        attempts,
        status: input.terminal || attempts >= current.maxAttempts ? 'dead' : 'failed',
        lastFailureReason: input.reason,
        lease: undefined,
        availableAt: cloneRecord(input.retryAt ?? input.now),
        updatedAt: cloneRecord(input.now)
      })
      return ok(undefined)
    },
    async cleanupTerminal(input) {
      if (!isOutboxCleanupTerminalInput(input)) {
        return err(storeFailure('OUTBOX_LEASE_CONFLICT'))
      }
      const eligible = [...state.messages.entries()]
        .filter(([, message]) => input.statuses.includes(message.status as 'dispatched' | 'dead')
          && message.updatedAt <= input.before
          && (input.tenantId === undefined || message.tenantId === input.tenantId))
        .sort((left, right) => left[1].updatedAt.getTime() - right[1].updatedAt.getTime()
          || left[1].tenantId.localeCompare(right[1].tenantId)
          || left[1].messageId.localeCompare(right[1].messageId))
        .slice(0, input.limit)
      for (const [key, message] of eligible) {
        state.messages.delete(key)
        if (message.idempotencyKey !== undefined) {
          const idempotencyKey = outboxKey(message.tenantId, message.idempotencyKey)
          if (state.idempotencyKeys.get(idempotencyKey) === message.messageId) {
            state.idempotencyKeys.delete(idempotencyKey)
          }
        }
      }
      return ok(eligible.length)
    },
    __unsafeMessages: state.messages,
    __unsafeIdempotencyKeys: state.idempotencyKeys
  }
}

type MemoryOutboxTransactionState = {
  readonly owner: MemoryOutboxState
  readonly working: MemoryOutboxState
}

const memoryOutboxTransactions = new WeakMap<TransactionContext, MemoryOutboxTransactionState>()

export function cloneMemoryOutboxState(state: MemoryOutboxState): MemoryOutboxState {
  return {
    messages: new Map(state.messages),
    idempotencyKeys: new Map(state.idempotencyKeys),
    leaseSequence: state.leaseSequence
  }
}

export async function runWithMemoryOutboxTransactionState<T>(
  state: MemoryOutboxState,
  tx: TransactionContext,
  working: MemoryOutboxState,
  fn: () => Promise<T>
): Promise<T> {
  memoryOutboxTransactions.set(tx, { owner: state, working })
  try {
    return await fn()
  } finally {
    memoryOutboxTransactions.delete(tx)
  }
}

export function canCommitMemoryOutboxState(
  state: MemoryOutboxState,
  before: MemoryOutboxState,
  working: MemoryOutboxState
): boolean {
  return mapsMatch(state.messages, before.messages)
    && mapsMatch(state.idempotencyKeys, before.idempotencyKeys)
    && state.leaseSequence === before.leaseSequence
    && !mapHasConflict(state.messages, before.messages, working.messages)
    && !mapHasConflict(state.idempotencyKeys, before.idempotencyKeys, working.idempotencyKeys)
    && (working.leaseSequence === before.leaseSequence || state.leaseSequence === before.leaseSequence)
}

export function applyMemoryOutboxState(
  state: MemoryOutboxState,
  before: MemoryOutboxState,
  working: MemoryOutboxState
): void {
  applyMapChanges(state.messages, before.messages, working.messages)
  applyMapChanges(state.idempotencyKeys, before.idempotencyKeys, working.idempotencyKeys)
  if (working.leaseSequence !== before.leaseSequence) state.leaseSequence = working.leaseSequence
}

function memoryOutboxStateFor(
  state: MemoryOutboxState,
  tx?: TransactionContext
): MemoryOutboxState | undefined {
  if (!tx) return state
  const transaction = memoryOutboxTransactions.get(tx)
  return transaction?.owner === state && tx.covers.includes('outbox')
    ? transaction.working
    : undefined
}

type LeaseMutationInput = Parameters<OutboxStore['markDispatched']>[0]

function validOutboxLease(
  message: StoredOutboxMessage | undefined,
  input: LeaseMutationInput
): message is LeasedOutboxMessage {
  return message?.status === 'claimed'
    && isRecord(message.lease)
    && message.tenantId === input.tenantId
    && message.messageId === input.messageId
    && message.lease.workerId === input.workerId
    && message.lease.leaseId === input.leaseId
    && message.lease.leaseUntil instanceof Date
    && message.lease.leaseUntil > input.now
}

function outboxKey(tenantId: string, value: string): string {
  return `${tenantId}\u0000${value}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mapHasConflict<K, V>(
  base: Map<K, V>,
  before: Map<K, V>,
  working: Map<K, V>
): boolean {
  for (const key of new Set([...before.keys(), ...working.keys()])) {
    if (!mapEntryMatches(before, working, key) && !mapEntryMatches(before, base, key)) return true
  }
  return false
}

function mapsMatch<K, V>(left: Map<K, V>, right: Map<K, V>): boolean {
  if (left.size !== right.size) return false
  for (const key of left.keys()) {
    if (!mapEntryMatches(left, right, key)) return false
  }
  return true
}

function applyMapChanges<K, V>(
  base: Map<K, V>,
  before: Map<K, V>,
  working: Map<K, V>
): void {
  for (const key of new Set([...before.keys(), ...working.keys()])) {
    if (mapEntryMatches(before, working, key)) continue
    if (working.has(key)) {
      base.set(key, working.get(key) as V)
    } else {
      base.delete(key)
    }
  }
}

function mapEntryMatches<K, V>(left: Map<K, V>, right: Map<K, V>, key: K): boolean {
  return left.has(key) === right.has(key) && left.get(key) === right.get(key)
}
