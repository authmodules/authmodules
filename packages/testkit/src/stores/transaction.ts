import type { Result } from '@authmodules/contracts/result'
import type {
  TransactionContext,
  TransactionFailure,
  TransactionRequest,
  TransactionRunner,
  TransactionScope
} from '@authmodules/contracts/transaction'
import { err } from '../shared/result.ts'
import {
  applyTransactionState,
  canCommitTransactionState,
  cloneState,
  runWithTransactionState,
  type MemoryState
} from './state.ts'
import {
  applyMemoryOutboxState,
  canCommitMemoryOutboxState,
  cloneMemoryOutboxState,
  runWithMemoryOutboxTransactionState,
  type MemoryOutboxState
} from './memory-outbox-store.ts'

export function createMemoryTransaction(
  state: MemoryState,
  outboxState?: MemoryOutboxState
): TransactionRunner {
  const supportedScopes: readonly TransactionScope[] = [
    'accounts',
    'identities',
    'credentials',
    'sessions',
    'challenges',
    ...(outboxState ? ['outbox'] : [])
  ]
  let transactionSequence = 0
  let queue: Promise<void> = Promise.resolve()
  return {
    async run<T, E>(
      request: TransactionRequest,
      fn: (tx: TransactionContext) => Promise<Result<T, E>>
    ): Promise<Result<T, E | TransactionFailure>> {
      if (!isTransactionRequest(request, supportedScopes) || typeof fn !== 'function') {
        return transactionError()
      }
      let release = (): void => {}
      const turn = new Promise<void>((resolve) => {
        release = resolve
      })
      const previous = queue
      queue = previous.then(() => turn)
      await previous
      const before = cloneState(state)
      const working = cloneState(before)
      const outboxBefore = outboxState ? cloneMemoryOutboxState(outboxState) : undefined
      const outboxWorking = outboxBefore ? cloneMemoryOutboxState(outboxBefore) : undefined
      transactionSequence += 1
      const tx = Object.freeze({
        transactionId: `tx_${transactionSequence}`,
        covers: Object.freeze([...request.requiredScopes])
      })

      try {
        const result = await runWithTransactionState(state, tx, working, () => (
          outboxState && outboxWorking
            ? runWithMemoryOutboxTransactionState(outboxState, tx, outboxWorking, () => fn(tx))
            : fn(tx)
        ))
        if (result.ok) {
          const authCanCommit = canCommitTransactionState(state, before, working, tx.covers)
          const outboxCanCommit = !outboxState || !outboxBefore || !outboxWorking
            || canCommitMemoryOutboxState(outboxState, outboxBefore, outboxWorking)
          if (!authCanCommit || !outboxCanCommit) return transactionError()
          applyTransactionState(state, before, working)
          if (outboxState && outboxBefore && outboxWorking) {
            applyMemoryOutboxState(outboxState, outboxBefore, outboxWorking)
          }
        }
        return result
      } catch {
        return transactionError()
      } finally {
        release()
      }
    }
  }
}

function transactionError(): Result<never, TransactionFailure> {
  return err({
    type: 'component.failure',
    component: 'transaction',
    reason: 'TRANSACTION_FAILED'
  })
}

function isTransactionRequest(
  value: unknown,
  supportedScopes: readonly TransactionScope[]
): value is TransactionRequest {
  if (!isRecord(value)
    || Object.keys(value).length !== 1
    || !Array.isArray(value.requiredScopes)
    || value.requiredScopes.length === 0
    || value.requiredScopes.length > 1000
    || new Set(value.requiredScopes).size !== value.requiredScopes.length) {
    return false
  }
  return value.requiredScopes.every((scope) => (
    typeof scope === 'string'
    && scope.length > 0
    && scope.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(scope)
    && supportedScopes.includes(scope)
  ))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
