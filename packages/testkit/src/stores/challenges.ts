import type { ChallengeRecord, ChallengeStore } from '@authmodules/contracts/store'
import { err, ok } from '../shared/result.ts'
import { storeFailure } from './failure.ts'
import { isChallengeRecord } from './record-validation.ts'
import {
  challengeKey,
  cloneRecord,
  memoryStateFor,
  snapshotDate,
  snapshotRecord,
  type MemoryState
} from './state.ts'

export function createMemoryChallengesStore(state: MemoryState): ChallengeStore {
  return {
    async create(input, tx) {
      const current = memoryStateFor(state, 'challenges', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const record = snapshotRecord(input.record, isChallengeRecord)
      if (!record) return err(storeFailure('STORE_UNAVAILABLE'))
      const key = challengeKey(record.tenantId, record.challengeId)
      if (current.challenges.has(key)) return err(storeFailure('STORE_UNAVAILABLE'))
      current.challenges.set(key, record)
      return ok(cloneRecord(record))
    },
    async findById(input, tx) {
      const current = memoryStateFor(state, 'challenges', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      return ok(cloneRecord(current.challenges.get(challengeKey(input.tenantId, input.challengeId))) ?? null)
    },
    async recordFailedAttempt(input, tx) {
      const current = memoryStateFor(state, 'challenges', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const now = snapshotDate(input.now)
      if (!now) return err(storeFailure('STORE_UNAVAILABLE'))
      const key = challengeKey(input.tenantId, input.challengeId)
      const record = current.challenges.get(key)
      if (!record) {
        return err(storeFailure('CHALLENGE_NOT_FOUND'))
      }
      if (record.version !== input.expectedVersion) {
        return ok({ status: 'version-conflict' })
      }
      if (record.status === 'consumed') return ok({ status: 'version-conflict' })
      if (record.status === 'failed' || record.attempts >= record.maxAttempts) {
        return ok({ status: 'attempts-exceeded', challenge: cloneRecord(record) })
      }
      if (record.status === 'expired') return ok({ status: 'expired', challenge: cloneRecord(record) })
      if (record.expiresAt <= now) {
        const expired: ChallengeRecord = {
          ...record,
          status: 'expired',
          updatedAt: now,
          version: record.version + 1
        }
        current.challenges.set(key, expired)
        return ok({ status: 'expired', challenge: cloneRecord(expired) })
      }
      const attempts = record.attempts + 1
      const status = attempts >= record.maxAttempts ? 'failed' : record.status
      const updated: ChallengeRecord = {
        ...record,
        attempts,
        status,
        updatedAt: now,
        version: record.version + 1
      }
      current.challenges.set(key, updated)
      return ok({
        status: status === 'failed' ? 'attempts-exceeded' : 'recorded',
        challenge: cloneRecord(updated)
      })
    },
    async consumePending(input, tx) {
      const current = memoryStateFor(state, 'challenges', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const now = snapshotDate(input.now)
      if (!now) return err(storeFailure('STORE_UNAVAILABLE'))
      const key = challengeKey(input.tenantId, input.challengeId)
      const record = current.challenges.get(key)
      if (!record) {
        return err(storeFailure('CHALLENGE_NOT_FOUND'))
      }
      if (record.version !== input.expectedVersion) {
        return ok('version-conflict')
      }
      if (record.status === 'consumed') {
        return ok('already-consumed')
      }
      if (record.status === 'expired') return ok('expired')
      if (record.expiresAt <= now) {
        current.challenges.set(key, {
          ...record,
          status: 'expired',
          version: record.version + 1,
          updatedAt: now
        })
        return ok('expired')
      }
      if (record.status === 'failed' || record.attempts >= record.maxAttempts) {
        return ok('attempts-exceeded')
      }
      current.challenges.set(key, {
        ...record,
        status: 'consumed',
        consumedAt: now,
        version: record.version + 1,
        updatedAt: new Date(now)
      })
      return ok('consumed')
    },
    async cleanupExpired(input, tx) {
      const current = memoryStateFor(state, 'challenges', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const limit = cleanupLimit(input.limit)
      const now = snapshotDate(input.now)
      if (limit === undefined || !now) return err(storeFailure('STORE_UNAVAILABLE'))
      let count = 0
      for (const [key, record] of current.challenges) {
        if (record.tenantId !== input.tenantId || record.status !== 'pending' || record.expiresAt > now) {
          continue
        }
        if (count >= limit) {
          break
        }
        current.challenges.set(key, {
          ...record,
          status: 'expired',
          updatedAt: new Date(now),
          version: record.version + 1
        })
        count += 1
      }
      return ok(count)
    }
  }
}

function cleanupLimit(value: unknown): number | undefined {
  if (value === undefined) return 1000
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1000
    ? Number(value)
    : undefined
}
