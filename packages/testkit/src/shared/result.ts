import type { Result } from '@authmodules/contracts/result'

export function ok<T>(value: T): Result<T, never>

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E>

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}
