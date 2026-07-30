import type { SecretFactory } from '@authmodules/contracts/security'
import type { SessionStore } from '@authmodules/contracts/store'
import { queryCount, queryNullable, queryRecord } from '../database/query.ts'
import type { PostgresClientFor } from '../database/types.ts'
import { sessionFromRow } from '../records/mappers.ts'
import { isSessionRecord } from '../records/validation.ts'
import { persistedTokenHash } from '../serialization/secrets.ts'
import { storeErr } from '../shared/result.ts'
import { cleanupLimit } from './helpers.ts'

export function createPostgresSessionsStore(
  clientFor: PostgresClientFor,
  secretFactory?: Pick<SecretFactory, 'protectedValue' | 'sealedValue'>
): SessionStore {
  const findById: SessionStore['findById'] = async (input, tx) => (
    queryNullable(clientFor(tx), (row) => sessionFromRow(row, secretFactory), `select * from authmodules_sessions
          where tenant_id = $1 and session_id = $2`, [input.tenantId, input.sessionId])
  )

  return {
    async create(input, tx) {
      if (!isSessionRecord(input.record)) return storeErr('STORE_UNAVAILABLE')
      const tokenHash = persistedTokenHash(input.record.tokenHash)
      if (!tokenHash.ok) return tokenHash
      return queryRecord(clientFor(tx), (row) => sessionFromRow(row, secretFactory), `insert into authmodules_sessions
            (tenant_id, session_id, account_id, token_hash, token_hash_scheme, token_hash_key_id,
              token_hash_value, status, issued_at, expires_at, revoked_at, created_at, updated_at)
            values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            returning *`, [
        input.record.tenantId,
        input.record.sessionId,
        input.record.accountId,
        tokenHash.value.json,
        tokenHash.value.scheme,
        tokenHash.value.keyId,
        tokenHash.value.verifier,
        input.record.status,
        input.record.issuedAt,
        input.record.expiresAt,
        input.record.revokedAt,
        input.record.createdAt,
        input.record.updatedAt
      ])
    },
    findById,
    async findByTokenHash(input, tx) {
      const tokenHash = persistedTokenHash(input.tokenHash)
      if (!tokenHash.ok) return tokenHash
      return queryNullable(clientFor(tx), (row) => sessionFromRow(row, secretFactory), `select * from authmodules_sessions
            where tenant_id = $1
              and token_hash_scheme = $2
              and token_hash_key_id = $3
              and token_hash_value = $4`, [
        input.tenantId,
        tokenHash.value.scheme,
        tokenHash.value.keyId,
        tokenHash.value.verifier
      ])
    },
    async revoke(input, tx) {
      const current = await findById({ tenantId: input.tenantId, sessionId: input.sessionId }, tx)
      if (!current.ok || !current.value) {
        return current.ok ? { ok: true, value: null } : current
      }
      if (current.value.status !== 'active') {
        return current
      }
      const updated = await queryNullable(clientFor(tx), (row) => sessionFromRow(row, secretFactory), `update authmodules_sessions
            set status = 'revoked', revoked_at = $3, updated_at = $3
            where tenant_id = $1 and session_id = $2 and status = 'active'
            returning *`, [input.tenantId, input.sessionId, input.now])
      if (!updated.ok || updated.value) {
        return updated
      }
      return findById({ tenantId: input.tenantId, sessionId: input.sessionId }, tx)
    },
    async cleanupExpired(input, tx) {
      const limit = cleanupLimit(input.limit)
      if (!limit.ok) return limit
      return queryCount(clientFor(tx), `with expired as (
              select tenant_id, session_id from authmodules_sessions
              where tenant_id = $1 and status = 'active' and expires_at <= $2
              order by expires_at, session_id
              limit $3
              for update skip locked
            )
            update authmodules_sessions as sessions
            set status = 'expired', updated_at = $2
            from expired
            where sessions.tenant_id = expired.tenant_id
              and sessions.session_id = expired.session_id`, [input.tenantId, input.now, limit.value])
    }
  }
}
