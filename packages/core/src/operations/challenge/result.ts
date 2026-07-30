import type { InternalAuthReason } from '@authmodules/contracts/errors'
import type { ConsumePendingResult, RecordFailedAttemptResult } from '@authmodules/contracts/store'

export function challengeResultToReason(result: Exclude<ConsumePendingResult, 'consumed'>): InternalAuthReason {
  if (result === 'already-consumed') return 'CHALLENGE_ALREADY_CONSUMED'
  if (result === 'expired') return 'CHALLENGE_EXPIRED'
  if (result === 'attempts-exceeded') return 'CHALLENGE_ATTEMPTS_EXCEEDED'
  return 'CHALLENGE_VERSION_CONFLICT'
}

export function challengeRecordFailedAttemptReason(
  status: Exclude<RecordFailedAttemptResult['status'], 'recorded'>
): InternalAuthReason {
  if (status === 'attempts-exceeded') return 'CHALLENGE_ATTEMPTS_EXCEEDED'
  if (status === 'expired') return 'CHALLENGE_EXPIRED'
  return 'CHALLENGE_VERSION_CONFLICT'
}
