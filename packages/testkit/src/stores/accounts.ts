import type { AccountStore } from '@authmodules/contracts/store'
import { err, ok } from '../shared/result.ts'
import { storeFailure } from './failure.ts'
import { isAccountRecord } from './record-validation.ts'
import {
  accountKey,
  canTransitionAccountStatus,
  cloneRecord,
  memoryStateFor,
  snapshotDate,
  snapshotRecord,
  type MemoryState
} from './state.ts'

export function createMemoryAccountsStore(state: MemoryState): AccountStore {
  return {
    async create(input, tx) {
      const current = memoryStateFor(state, 'accounts', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const record = snapshotRecord(input.record, isAccountRecord)
      if (!record) return err(storeFailure('STORE_UNAVAILABLE'))
      const key = accountKey(record.tenantId, record.accountId)
      if (current.accounts.has(key)) return err(storeFailure('STORE_UNAVAILABLE'))
      current.accounts.set(key, record)
      return ok(cloneRecord(record))
    },
    async findById(input, tx) {
      const current = memoryStateFor(state, 'accounts', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      return ok(cloneRecord(current.accounts.get(accountKey(input.tenantId, input.accountId))) ?? null)
    },
    async updateStatus(input, tx) {
      const current = memoryStateFor(state, 'accounts', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const now = snapshotDate(input.now)
      if (!now) return err(storeFailure('STORE_UNAVAILABLE'))
      const key = accountKey(input.tenantId, input.accountId)
      const record = current.accounts.get(key)
      if (!record) {
        return err(storeFailure('ACCOUNT_NOT_FOUND'))
      }
      if (!canTransitionAccountStatus(record.status, input.status)) return err(storeFailure('STORE_UNAVAILABLE'))
      const updated = { ...record, status: input.status, updatedAt: now }
      current.accounts.set(key, updated)
      return ok(cloneRecord(updated))
    }
  }
}
