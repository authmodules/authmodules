import type { SecretFactory } from '@authmodules/contracts/security'
import type { ChallengeStore } from '@authmodules/contracts/store'
import { queryCount, queryNullable, queryRecord } from '../database/query.ts'
import type { PostgresClientFor } from '../database/types.ts'
import { challengeFromRow } from '../records/mappers.ts'
import { isChallengeRecord } from '../records/validation.ts'
import { persistedJson, persistedPlainJson } from '../serialization/json.ts'
import { storeErr } from '../shared/result.ts'
import { cleanupLimit, updateChallengeStatus } from './helpers.ts'

export function createPostgresChallengesStore(
  clientFor: PostgresClientFor,
  secretFactory?: Pick<SecretFactory, 'protectedValue' | 'sealedValue'>
): ChallengeStore {
  const findById: ChallengeStore['findById'] = async (input, tx) => (
    queryNullable(clientFor(tx), (row) => challengeFromRow(row, secretFactory), `select * from authmodules_challenges
          where tenant_id = $1 and challenge_id = $2`, [input.tenantId, input.challengeId])
  )

  return {
    async create(input, tx) {
      if (!isChallengeRecord(input.record)) return storeErr('STORE_UNAVAILABLE')
      const material = persistedJson(input.record.material)
      if (!material.ok) return material
      const lookup = persistedPlainJson(input.record.lookup)
      if (!lookup.ok) return lookup
      const binding = persistedPlainJson(input.record.binding)
      if (!binding.ok) return binding
      return queryRecord(clientFor(tx), (row) => challengeFromRow(row, secretFactory), `insert into authmodules_challenges
            (tenant_id, challenge_id, method_id, method_kind, lookup, status, material, binding, attempts, max_attempts, version, expires_at, consumed_at, created_at, updated_at)
            values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
            returning *`, [
        input.record.tenantId,
        input.record.challengeId,
        input.record.methodId,
        input.record.methodKind,
        lookup.value,
        input.record.status,
        material.value,
        binding.value,
        input.record.attempts,
        input.record.maxAttempts,
        input.record.version,
        input.record.expiresAt,
        input.record.consumedAt,
        input.record.createdAt,
        input.record.updatedAt
      ])
    },
    findById,
    async recordFailedAttempt(input, tx) {
      const current = await findById({ tenantId: input.tenantId, challengeId: input.challengeId }, tx)
      if (!current.ok) return current
      if (!current.value) return storeErr('CHALLENGE_NOT_FOUND')
      if (current.value.version !== input.expectedVersion) return { ok: true, value: { status: 'version-conflict' } }
      if (current.value.status === 'consumed') return { ok: true, value: { status: 'version-conflict' } }
      if (current.value.status === 'failed' || current.value.attempts >= current.value.maxAttempts) {
        return { ok: true, value: { status: 'attempts-exceeded', challenge: current.value } }
      }
      if (current.value.status === 'expired') {
        return { ok: true, value: { status: 'expired', challenge: current.value } }
      }
      if (current.value.expiresAt <= input.now) {
        const updated = await updateChallengeStatus(clientFor(tx), secretFactory, input, 'expired')
        if (!updated.ok) return updated
        return updated.value
          ? { ok: true, value: { status: 'expired', challenge: updated.value } }
          : { ok: true, value: { status: 'version-conflict' } }
      }
      const attempts = current.value.attempts + 1
      const status = attempts >= current.value.maxAttempts ? 'failed' : current.value.status
      const updated = await queryNullable(clientFor(tx), (row) => challengeFromRow(row, secretFactory), `update authmodules_challenges
            set attempts = $4, status = $5, version = version + 1, updated_at = $6
            where tenant_id = $1 and challenge_id = $2 and version = $3 and status = 'pending'
            returning *`, [input.tenantId, input.challengeId, input.expectedVersion, attempts, status, input.now])
      if (!updated.ok) return updated
      if (!updated.value) return { ok: true, value: { status: 'version-conflict' } }
      return { ok: true, value: { status: status === 'failed' ? 'attempts-exceeded' : 'recorded', challenge: updated.value } }
    },
    async consumePending(input, tx) {
      const current = await findById({ tenantId: input.tenantId, challengeId: input.challengeId }, tx)
      if (!current.ok) return current
      if (!current.value) return storeErr('CHALLENGE_NOT_FOUND')
      if (current.value.version !== input.expectedVersion) return { ok: true, value: 'version-conflict' }
      if (current.value.status === 'consumed') return { ok: true, value: 'already-consumed' }
      if (current.value.status === 'expired') {
        return { ok: true, value: 'expired' }
      }
      if (current.value.expiresAt <= input.now) {
        const updated = await updateChallengeStatus(clientFor(tx), secretFactory, input, 'expired')
        if (!updated.ok) return updated
        return { ok: true, value: updated.value ? 'expired' : 'version-conflict' }
      }
      if (current.value.status === 'failed' || current.value.attempts >= current.value.maxAttempts) {
        return { ok: true, value: 'attempts-exceeded' }
      }
      const updated = await queryNullable(clientFor(tx), (row) => challengeFromRow(row, secretFactory), `update authmodules_challenges
            set status = 'consumed', consumed_at = $4, version = version + 1, updated_at = $4
            where tenant_id = $1 and challenge_id = $2 and version = $3 and status = 'pending'
            returning *`, [input.tenantId, input.challengeId, input.expectedVersion, input.now])
      if (!updated.ok) return updated
      return { ok: true, value: updated.value ? 'consumed' : 'version-conflict' }
    },
    async cleanupExpired(input, tx) {
      const limit = cleanupLimit(input.limit)
      if (!limit.ok) return limit
      return queryCount(clientFor(tx), `with expired as (
              select tenant_id, challenge_id from authmodules_challenges
              where tenant_id = $1 and status = 'pending' and expires_at <= $2
              order by expires_at, challenge_id
              limit $3
              for update skip locked
            )
            update authmodules_challenges as challenges
            set status = 'expired', updated_at = $2, version = version + 1
            from expired
            where challenges.tenant_id = expired.tenant_id
              and challenges.challenge_id = expired.challenge_id`, [input.tenantId, input.now, limit.value])
    }
  }
}
