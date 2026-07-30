import type { InternalAuthReason, StoreFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import type { PostgresClient } from './types.ts'
import { storeErr } from '../shared/result.ts'

export async function queryRecord<T>(
  client: PostgresClient,
  mapper: (row: unknown) => T,
  sql: string,
  params?: readonly unknown[]
): Promise<Result<T, StoreFailure>> {
  const result = await safeQuery(client, sql, params)
  if (!result.ok) return result
  const row = rowsOf(result.value)[0]
  if (!row) return storeErr('STORE_UNAVAILABLE')
  try {
    return { ok: true, value: mapper(row) }
  } catch {
    return storeErr('STORE_UNAVAILABLE')
  }
}

export async function queryNullable<T>(
  client: PostgresClient,
  mapper: (row: unknown) => T,
  sql: string,
  params?: readonly unknown[]
): Promise<Result<T | null, StoreFailure>> {
  const result = await safeQuery(client, sql, params)
  if (!result.ok) return result
  const row = rowsOf(result.value)[0]
  if (!row) return { ok: true, value: null }
  try {
    return { ok: true, value: mapper(row) }
  } catch {
    return storeErr('STORE_UNAVAILABLE')
  }
}

export async function queryCount(
  client: PostgresClient,
  sql: string,
  params?: readonly unknown[]
): Promise<Result<number, StoreFailure>> {
  const result = await safeQuery(client, sql, params)
  if (!result.ok) return result
  const count = isRecord(result.value) ? result.value.rowCount : undefined
  if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) {
    return storeErr('STORE_UNAVAILABLE')
  }
  return { ok: true, value: typeof count === 'number' ? count : rowsOf(result.value).length }
}

async function safeQuery(
  client: PostgresClient,
  sql: string,
  params?: readonly unknown[]
): Promise<Result<unknown, StoreFailure>> {
  try {
    const value = await client.query(sql, params)
    if (!value || (typeof value !== 'object' && !Array.isArray(value))) return storeErr('STORE_UNAVAILABLE')
    return { ok: true, value }
  } catch (error) {
    return storeErr(postgresReason(error))
  }
}

function postgresReason(error: unknown): InternalAuthReason {
  if (!isRecord(error) || error.code !== '23505') return 'STORE_UNAVAILABLE'
  if (error.constraint === 'authmodules_identities_subject_uniq') return 'IDENTITY_CONFLICT'
  if (error.constraint === 'authmodules_credentials_identity_method_uniq') return 'CREDENTIAL_CONFLICT'
  if (error.constraint === 'authmodules_outbox_pkey') return 'OUTBOX_ENQUEUE_FAILED'
  return 'STORE_UNAVAILABLE'
}

function rowsOf(result: unknown): readonly unknown[] {
  if (Array.isArray(result)) return result
  return isRecord(result) && Array.isArray(result.rows) ? result.rows : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
