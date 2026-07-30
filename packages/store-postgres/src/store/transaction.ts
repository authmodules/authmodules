import type { Result } from '@authmodules/contracts/result'
import type {
  TransactionContext,
  TransactionFailure,
  TransactionRequest,
  TransactionRunner,
  TransactionScope
} from '@authmodules/contracts/transaction'
import type { PostgresClient } from '../database/types.ts'
import { isFailureResult } from '../shared/validation.ts'
import { transactionFailure } from './helpers.ts'

export function createPostgresTransaction(
  client: PostgresClient,
  transactionClients: WeakMap<TransactionContext, PostgresClient>,
  supportedScopes: readonly TransactionScope[] = [
    'accounts',
    'identities',
    'credentials',
    'sessions',
    'challenges'
  ]): TransactionRunner {
  let transactionSequence = 0
  return {
    async run<T, E>(
      request: TransactionRequest,
      fn: (tx: TransactionContext) => Promise<Result<T, E>>
    ): Promise<Result<T, E | TransactionFailure>> {
      if (!isTransactionRequest(request, supportedScopes) || typeof fn !== 'function') {
        return transactionFailure()
      }
      transactionSequence += 1
      const tx = Object.freeze({
        transactionId: `pg_${transactionSequence}`,
        covers: Object.freeze([...request.requiredScopes])
      })
      const rollbackSignal = new Error('AUTHMODULES_TRANSACTION_ROLLBACK')
      const completionReceipt = Object.freeze({
        transactionId: tx.transactionId,
        status: 'completed'
      })
      let callbackCalls = 0
      let successfulResult: Result<T, E> | undefined
      let failedResult: Result<T, E | TransactionFailure> | undefined

      try {
        const transaction = client.transaction
        if (!transaction) return transactionFailure()
        const completed = await transaction(async (transactionClient): Promise<object> => {
          callbackCalls += 1
          if (callbackCalls !== 1) {
            throw new TypeError('PostgreSQL transaction provider invoked the callback more than once')
          }
          if (!transactionClient || typeof transactionClient.query !== 'function') {
            throw new TypeError('PostgreSQL transaction provider returned an invalid client')
          }
          transactionClients.set(tx, transactionClient)
          try {
            const result = await fn(tx)
            if (result?.ok !== true) {
              failedResult = isFailureResult(result) ? result as Result<T, E> : transactionFailure()
              throw rollbackSignal
            }
            successfulResult = result
            return completionReceipt
          } finally {
            transactionClients.delete(tx)
          }
        })
        return isCompletionReceipt(completed, tx.transactionId)
          && callbackCalls === 1
          && successfulResult?.ok === true
          ? successfulResult
          : transactionFailure()
      } catch (error) {
        if (error === rollbackSignal) return failedResult ?? transactionFailure()
        return transactionFailure()
      }
    }
  }
}

function isCompletionReceipt(value: unknown, transactionId: string): boolean {
  return isRecord(value)
    && Object.keys(value).length === 2
    && value.transactionId === transactionId
    && value.status === 'completed'
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
