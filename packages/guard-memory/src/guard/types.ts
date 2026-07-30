import type { AuthGuard } from '@authmodules/contracts/guard'

export type MemoryAttemptGuard = AuthGuard

export type MemoryAttemptGuardOptions = {
  readonly maxFailures?: number
  readonly windowSeconds?: number
  readonly retryAfterSeconds?: number
  readonly maxKeys?: number
  readonly now?: () => Date | number
}
