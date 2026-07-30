import type { Result } from './result.js'
import type { ComponentFailure } from './errors.js'
import type { ExtensionString } from './primitives.js'

export type TransactionScope =
  | 'accounts'
  | 'identities'
  | 'credentials'
  | 'sessions'
  | 'challenges'
  | ExtensionString

export type TransactionContext = {
  readonly transactionId: string
  readonly covers: readonly TransactionScope[]
}

export type TransactionRequest = {
  /** Every store scope that the callback may read or write. */
  readonly requiredScopes: readonly TransactionScope[]
}

export type TransactionFailure = ComponentFailure & {
  readonly component: 'transaction'
}

export interface TransactionRunner {
  /**
   * Reject unsupported scopes before invoking the callback.
   * Roll back on thrown error or Result.ok=false.
   */
  run<T, E>(
    request: TransactionRequest,
    fn: (tx: TransactionContext) => Promise<Result<T, E>>
  ): Promise<Result<T, E | TransactionFailure>>
}
