import type { CryptoFailure, InternalAuthReason } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function cryptoFailure(reason: InternalAuthReason): CryptoFailure {
  return { type: 'component.failure', component: 'crypto', reason }
}
