import type { CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthFailure, PublicAuthErrorCode } from '@authmodules/contracts/errors'
import type { AuthContext } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import type { TransactionContext, TransactionScope } from '@authmodules/contracts/transaction'
import { authErr } from '../shared/errors.ts'
import { isPublicData } from '../validation/input.ts'

const authFailureKeys = new Set(['internalDetails', 'internalReason', 'publicError', 'type'])
const publicErrorKeys = new Set(['code', 'message', 'publicDetails', 'requestId', 'retryAfterSeconds'])
const publicCodes = new Set<PublicAuthErrorCode>([
  'ACCOUNT_UNAVAILABLE',
  'AUTHENTICATION_FAILED',
  'AUTHORIZATION_FAILED',
  'CHALLENGE_FAILED',
  'CONFLICT',
  'INTERNAL',
  'INVALID_INPUT',
  'RATE_LIMITED',
  'SESSION_INVALID',
  'TEMPORARILY_UNAVAILABLE'
])

export async function runInStoreTransaction<T>(
  config: CreateAuthConfig,
  context: AuthContext,
  requiredScopes: readonly TransactionScope[],
  fn: (tx?: TransactionContext) => Promise<Result<T, AuthFailure>>
): Promise<Result<T, AuthFailure>> {
  const transaction = config.store.transaction
  if (requiredScopes.length === 0) {
    return fn(undefined)
  }
  if (!transaction) {
    return authErr(context, 'TRANSACTION_FAILED', 'TEMPORARILY_UNAVAILABLE')
  }

  try {
    let callbackCalls = 0
    let callbackResult: Result<T, AuthFailure> | undefined
    let callbackReceipt: { readonly transactionId: string } | undefined
    const result = await transaction.run<{ readonly transactionId: string }, AuthFailure>({ requiredScopes }, async (tx) => {
      callbackCalls += 1
      if (callbackCalls !== 1) {
        throw new TypeError('Transaction callback was invoked more than once')
      }
      if (!transactionCovers(tx, requiredScopes)) {
        const failure = authErr(context, 'TRANSACTION_FAILED', 'TEMPORARILY_UNAVAILABLE')
        callbackResult = failure
        return failure
      }
      const resultFromCallback = await fn(tx)
      callbackResult = resultFromCallback
      if (!resultFromCallback.ok) return resultFromCallback
      callbackReceipt = { transactionId: tx.transactionId }
      return { ok: true, value: callbackReceipt }
    })
    if (callbackCalls !== 1 || !callbackResult || !isResult(result)) {
      return authErr(context, 'TRANSACTION_FAILED', 'TEMPORARILY_UNAVAILABLE')
    }
    if (!callbackResult.ok) {
      if (!result.ok
        && isAuthFailure(result.error)
        && authFailuresMatch(callbackResult.error, result.error)) return callbackResult
      return authErr(context, 'TRANSACTION_FAILED', 'TEMPORARILY_UNAVAILABLE')
    }
    if (!result.ok || !callbackReceipt || !isTransactionReceipt(result.value, callbackReceipt)) {
      return authErr(context, 'TRANSACTION_FAILED', 'TEMPORARILY_UNAVAILABLE')
    }
    return callbackResult
  } catch {
    return authErr(context, 'TRANSACTION_FAILED', 'TEMPORARILY_UNAVAILABLE')
  }
}

function isTransactionReceipt(
  value: unknown,
  expected: { readonly transactionId: string }
): boolean {
  return isRecord(value)
    && Object.keys(value).length === 1
    && value.transactionId === expected.transactionId
}

function authFailuresMatch(left: AuthFailure, right: AuthFailure): boolean {
  return left.type === right.type
    && left.internalReason === right.internalReason
    && JSON.stringify(left.internalDetails) === JSON.stringify(right.internalDetails)
    && JSON.stringify(left.publicError) === JSON.stringify(right.publicError)
}

function transactionCovers(tx: unknown, requiredScopes: readonly TransactionScope[]): tx is TransactionContext {
  if (!isRecord(tx) || typeof tx.transactionId !== 'string' || !Array.isArray(tx.covers)) return false
  const covers = tx.covers
  return tx.transactionId.length > 0
    && tx.transactionId.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(tx.transactionId)
    && covers.length <= 1000
    && covers.every((scope) => typeof scope === 'string' && scope.length > 0 && scope.length <= 512)
    && requiredScopes.every((scope) => covers.includes(scope))
}

function isResult(value: unknown): value is Result<unknown, unknown> {
  return isRecord(value)
    && ((value.ok === true && 'value' in value)
      || (value.ok === false && 'error' in value))
}

function isAuthFailure(value: unknown): value is AuthFailure {
  if (!isRecord(value)
    || !hasOnlyKeys(value, authFailureKeys)
    || value.type !== 'auth.failure'
    || !isSafeText(value.internalReason, 512)
    || !isPublicData(value.internalDetails)) {
    return false
  }
  const publicError = value.publicError
  return isRecord(publicError)
    && hasOnlyKeys(publicError, publicErrorKeys)
    && publicCodes.has(publicError.code as PublicAuthErrorCode)
    && (publicError.message === undefined || isSafeText(publicError.message, 4096))
    && (publicError.requestId === undefined || isSafeText(publicError.requestId, 512))
    && (publicError.retryAfterSeconds === undefined
      || (Number.isSafeInteger(publicError.retryAfterSeconds) && Number(publicError.retryAfterSeconds) > 0))
    && isPublicData(publicError.publicDetails)
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
