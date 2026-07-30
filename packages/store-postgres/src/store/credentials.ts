import type { SecretFactory } from '@authmodules/contracts/security'
import type { CredentialStore } from '@authmodules/contracts/store'
import { queryNullable, queryRecord } from '../database/query.ts'
import type { PostgresClientFor } from '../database/types.ts'
import { credentialFromRow } from '../records/mappers.ts'
import { isCredentialRecord, isMethodMaterial } from '../records/validation.ts'
import { persistedJson } from '../serialization/json.ts'
import { storeErr } from '../shared/result.ts'

export function createPostgresCredentialsStore(
  clientFor: PostgresClientFor,
  secretFactory?: Pick<SecretFactory, 'protectedValue' | 'sealedValue'>
): CredentialStore {
  return {
    async create(input, tx) {
      if (!isCredentialRecord(input.record)) return storeErr('STORE_UNAVAILABLE')
      const material = persistedJson(input.record.material)
      if (!material.ok) return material
      return queryRecord(clientFor(tx), (row) => credentialFromRow(row, secretFactory), `insert into authmodules_credentials
            (tenant_id, credential_id, account_id, identity_id, method_id, method_kind, status, material, version, created_at, updated_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
            returning *`, [
        input.record.tenantId,
        input.record.credentialId,
        input.record.accountId,
        input.record.identityId,
        input.record.methodId,
        input.record.methodKind,
        input.record.status,
        material.value,
        input.record.version,
        input.record.createdAt,
        input.record.updatedAt
      ])
    },
    async findById(input, tx) {
      return queryNullable(clientFor(tx), (row) => credentialFromRow(row, secretFactory), `select * from authmodules_credentials
            where tenant_id = $1 and credential_id = $2${tx ? ' for share' : ''}`, [input.tenantId, input.credentialId])
    },
    async findForIdentity(input, tx) {
      return queryNullable(clientFor(tx), (row) => credentialFromRow(row, secretFactory), `select * from authmodules_credentials
            where tenant_id = $1 and identity_id = $2 and method_id = $3${tx ? ' for share' : ''}`, [
        input.tenantId,
        input.identityId,
        input.methodId
      ])
    },
    async replaceMaterial(input, tx) {
      if (!isMethodMaterial(input.material)) return storeErr('STORE_UNAVAILABLE')
      const material = persistedJson(input.material)
      if (!material.ok) return material
      const updated = await queryNullable(clientFor(tx), (row) => credentialFromRow(row, secretFactory), `update authmodules_credentials
            set material = $4::jsonb, version = version + 1, updated_at = $5
            where tenant_id = $1 and credential_id = $2 and version = $3
            returning *`, [input.tenantId, input.credentialId, input.expectedVersion, material.value, input.now])
      if (!updated.ok) return updated
      if (updated.value) return { ok: true, value: updated.value }
      return classifyCredentialUpdateFailure(
        clientFor,
        secretFactory,
        input.tenantId,
        input.credentialId,
        input.expectedVersion,
        tx
      )
    },
    async updateStatus(input, tx) {
      const updated = await queryNullable(clientFor(tx), (row) => credentialFromRow(row, secretFactory), `update authmodules_credentials
            set status = $4, version = version + 1, updated_at = $5
            where tenant_id = $1 and credential_id = $2 and version = $3
              and (
                (status = 'active' and $4 = 'disabled')
                or (status = 'disabled' and $4 = 'active')
              )
            returning *`, [input.tenantId, input.credentialId, input.expectedVersion, input.status, input.now])
      if (!updated.ok) return updated
      if (updated.value) return { ok: true, value: updated.value }
      return classifyCredentialUpdateFailure(
        clientFor,
        secretFactory,
        input.tenantId,
        input.credentialId,
        input.expectedVersion,
        tx
      )
    }
  }
}

async function classifyCredentialUpdateFailure(
  clientFor: PostgresClientFor,
  secretFactory: Pick<SecretFactory, 'protectedValue' | 'sealedValue'> | undefined,
  tenantId: string,
  credentialId: string,
  expectedVersion: number,
  tx: Parameters<PostgresClientFor>[0]
) {
  const current = await queryNullable(
    clientFor(tx),
    (row) => credentialFromRow(row, secretFactory),
    `select * from authmodules_credentials
      where tenant_id = $1 and credential_id = $2${tx ? ' for share' : ''}`,
    [tenantId, credentialId]
  )
  if (!current.ok) return current
  if (!current.value) return storeErr('CREDENTIAL_NOT_FOUND')
  return current.value.version !== expectedVersion
    ? storeErr('TRANSACTION_FAILED')
    : storeErr('STORE_UNAVAILABLE')
}
