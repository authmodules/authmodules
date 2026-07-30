import type { IdentityStore } from '@authmodules/contracts/store'
import { queryNullable, queryRecord } from '../database/query.ts'
import type { PostgresClientFor } from '../database/types.ts'
import { identityFromRow } from '../records/mappers.ts'
import { isIdentityRecord } from '../records/validation.ts'
import { storeErr } from '../shared/result.ts'

export function createPostgresIdentitiesStore(clientFor: PostgresClientFor): IdentityStore {
  return {
    async create(input, tx) {
      if (!isIdentityRecord(input.record)) return storeErr('STORE_UNAVAILABLE')
      return queryRecord(clientFor(tx), identityFromRow, `insert into authmodules_identities
            (tenant_id, identity_id, account_id, method_id, method_kind, subject, subject_kind, display, verified_at, created_at, updated_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            returning *`, [
        input.record.tenantId,
        input.record.identityId,
        input.record.accountId,
        input.record.methodId,
        input.record.methodKind,
        input.record.subject,
        input.record.subjectKind,
        input.record.display,
        input.record.verifiedAt,
        input.record.createdAt,
        input.record.updatedAt
      ])
    },
    async findById(input, tx) {
      return queryNullable(clientFor(tx), identityFromRow, `select * from authmodules_identities
            where tenant_id = $1 and identity_id = $2`, [input.tenantId, input.identityId])
    },
    async findBySubject(input, tx) {
      return queryNullable(clientFor(tx), identityFromRow, `select * from authmodules_identities
            where tenant_id = $1 and method_id = $2 and subject = $3`, [input.tenantId, input.methodId, input.subject])
    },
    async markVerified(input, tx) {
      return queryRecord(clientFor(tx), identityFromRow, `update authmodules_identities
            set verified_at = $3, updated_at = $4
            where tenant_id = $1 and identity_id = $2
            returning *`, [input.tenantId, input.identityId, input.verifiedAt, input.now])
    }
  }
}
