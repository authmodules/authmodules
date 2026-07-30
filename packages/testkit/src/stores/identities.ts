import type { IdentityStore } from '@authmodules/contracts/store'
import { err, ok } from '../shared/result.ts'
import { storeFailure } from './failure.ts'
import { isIdentityRecord } from './record-validation.ts'
import {
  accountKey,
  cloneRecord,
  identityKey,
  identitySubjectKey,
  memoryStateFor,
  snapshotDate,
  snapshotRecord,
  type MemoryState
} from './state.ts'

export function createMemoryIdentitiesStore(state: MemoryState): IdentityStore {
  return {
    async create(input, tx) {
      const current = memoryStateFor(state, 'identities', tx)
      const accounts = memoryStateFor(state, 'accounts', tx)
      if (!current || !accounts) return err(storeFailure('STORE_UNAVAILABLE'))
      const record = snapshotRecord(input.record, isIdentityRecord)
      if (!record) return err(storeFailure('STORE_UNAVAILABLE'))
      if (!accounts.accounts.has(accountKey(record.tenantId, record.accountId))) {
        return err(storeFailure('ACCOUNT_NOT_FOUND'))
      }
      const subjectKey = identitySubjectKey(record.tenantId, record.methodId, record.subject)
      if (current.identities.has(identityKey(record.tenantId, record.identityId)) || current.identitySubjects.has(subjectKey)) {
        return err(storeFailure('IDENTITY_CONFLICT'))
      }
      current.identities.set(identityKey(record.tenantId, record.identityId), record)
      current.identitySubjects.set(subjectKey, record.identityId)
      return ok(cloneRecord(record))
    },
    async findById(input, tx) {
      const current = memoryStateFor(state, 'identities', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      return ok(cloneRecord(current.identities.get(identityKey(input.tenantId, input.identityId))) ?? null)
    },
    async findBySubject(input, tx) {
      const current = memoryStateFor(state, 'identities', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const identityId = current.identitySubjects.get(identitySubjectKey(input.tenantId, input.methodId, input.subject))
      if (!identityId) {
        return ok(null)
      }
      return ok(cloneRecord(current.identities.get(identityKey(input.tenantId, identityId))) ?? null)
    },
    async markVerified(input, tx) {
      const current = memoryStateFor(state, 'identities', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const verifiedAt = snapshotDate(input.verifiedAt)
      const now = snapshotDate(input.now)
      if (!verifiedAt || !now) return err(storeFailure('STORE_UNAVAILABLE'))
      const key = identityKey(input.tenantId, input.identityId)
      const record = current.identities.get(key)
      if (!record) {
        return err(storeFailure('IDENTITY_NOT_FOUND'))
      }
      const updated = {
        ...record,
        verifiedAt,
        updatedAt: now
      }
      current.identities.set(key, updated)
      return ok(cloneRecord(updated))
    }
  }
}
