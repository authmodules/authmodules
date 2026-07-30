import type { Result } from '@authmodules/contracts/result'

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}
