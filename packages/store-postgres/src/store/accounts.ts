import type { AccountStore } from '@authmodules/contracts/store'
import { queryNullable, queryRecord } from '../database/query.ts'
import type { PostgresClientFor } from '../database/types.ts'
import { accountFromRow } from '../records/mappers.ts'
import { isAccountRecord } from '../records/validation.ts'
import { persistedPlainJson } from '../serialization/json.ts'
import { storeErr } from '../shared/result.ts'

export function createPostgresAccountsStore(clientFor: PostgresClientFor): AccountStore {
  return {
    async create(input, tx) {
      if (!isAccountRecord(input.record)) return storeErr('STORE_UNAVAILABLE')
      const publicData = persistedPlainJson(input.record.publicData)
      if (!publicData.ok) return publicData
      return queryRecord(clientFor(tx), accountFromRow, `insert into authmodules_accounts
            (tenant_id, account_id, status, public_data, created_at, updated_at)
            values ($1, $2, $3, $4::jsonb, $5, $6)
            returning *`, [
        input.record.tenantId,
        input.record.accountId,
        input.record.status,
        publicData.value,
        input.record.createdAt,
        input.record.updatedAt
      ])
    },
    async findById(input, tx) {
      return queryNullable(clientFor(tx), accountFromRow, `select * from authmodules_accounts
            where tenant_id = $1 and account_id = $2${tx ? ' for share' : ''}`, [input.tenantId, input.accountId])
    },
    async updateStatus(input, tx) {
      return queryRecord(clientFor(tx), accountFromRow, `update authmodules_accounts
            set status = $3, updated_at = $4
            where tenant_id = $1 and account_id = $2
              and (
                (status = 'active' and $3 in ('disabled', 'deleted'))
                or (status = 'disabled' and $3 in ('active', 'deleted'))
              )
            returning *`, [input.tenantId, input.accountId, input.status, input.now])
    }
  }
}
