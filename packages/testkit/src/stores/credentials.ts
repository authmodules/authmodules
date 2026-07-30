import type { CredentialStore } from '@authmodules/contracts/store'
import { err, ok } from '../shared/result.ts'
import { storeFailure } from './failure.ts'
import { isCredentialRecord, isMethodMaterial } from './record-validation.ts'
import {
  canTransitionCredentialStatus,
  accountKey,
  cloneRecord,
  credentialIdentityKey,
  credentialKey,
  identityKey,
  memoryStateFor,
  snapshotDate,
  snapshotRecord,
  type MemoryState
} from './state.ts'

export function createMemoryCredentialsStore(state: MemoryState): CredentialStore {
  return {
    async create(input, tx) {
      const current = memoryStateFor(state, 'credentials', tx)
      const accounts = memoryStateFor(state, 'accounts', tx)
      const identities = memoryStateFor(state, 'identities', tx)
      if (!current || !accounts || !identities) return err(storeFailure('STORE_UNAVAILABLE'))
      const record = snapshotRecord(input.record, isCredentialRecord)
      if (!record) return err(storeFailure('STORE_UNAVAILABLE'))
      const identity = identities.identities.get(identityKey(record.tenantId, record.identityId))
      if (!accounts.accounts.has(accountKey(record.tenantId, record.accountId))
        || !identity
        || identity.accountId !== record.accountId
        || identity.methodId !== record.methodId
        || identity.methodKind !== record.methodKind) {
        return err(storeFailure('CREDENTIAL_CONFLICT'))
      }
      const key = credentialKey(record.tenantId, record.credentialId)
      const recordIdentityKey = credentialIdentityKey(record.tenantId, record.identityId, record.methodId)
      if (current.credentials.has(key) || current.credentialsByIdentity.has(recordIdentityKey)) {
        return err(storeFailure('CREDENTIAL_CONFLICT'))
      }
      current.credentials.set(key, record)
      current.credentialsByIdentity.set(recordIdentityKey, record.credentialId)
      return ok(cloneRecord(record))
    },
    async findById(input, tx) {
      const current = memoryStateFor(state, 'credentials', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      return ok(cloneRecord(current.credentials.get(credentialKey(input.tenantId, input.credentialId))) ?? null)
    },
    async findForIdentity(input, tx) {
      const current = memoryStateFor(state, 'credentials', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const credentialId = current.credentialsByIdentity.get(credentialIdentityKey(input.tenantId, input.identityId, input.methodId))
      if (!credentialId) {
        return ok(null)
      }
      return ok(cloneRecord(current.credentials.get(credentialKey(input.tenantId, credentialId))) ?? null)
    },
    async replaceMaterial(input, tx) {
      const current = memoryStateFor(state, 'credentials', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const now = snapshotDate(input.now)
      if (!now) return err(storeFailure('STORE_UNAVAILABLE'))
      const material = snapshotRecord(input.material, isMethodMaterial)
      if (!material) return err(storeFailure('STORE_UNAVAILABLE'))
      const key = credentialKey(input.tenantId, input.credentialId)
      const record = current.credentials.get(key)
      if (!record) {
        return err(storeFailure('CREDENTIAL_NOT_FOUND'))
      }
      if (record.version !== input.expectedVersion) {
        return err(storeFailure('TRANSACTION_FAILED', { expectedVersion: input.expectedVersion }))
      }
      const updated = {
        ...record,
        material,
        version: record.version + 1,
        updatedAt: now
      }
      current.credentials.set(key, updated)
      return ok(cloneRecord(updated))
    },
    async updateStatus(input, tx) {
      const current = memoryStateFor(state, 'credentials', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const now = snapshotDate(input.now)
      if (!now) return err(storeFailure('STORE_UNAVAILABLE'))
      const key = credentialKey(input.tenantId, input.credentialId)
      const record = current.credentials.get(key)
      if (!record) {
        return err(storeFailure('CREDENTIAL_NOT_FOUND'))
      }
      if (record.version !== input.expectedVersion) {
        return err(storeFailure('TRANSACTION_FAILED', { expectedVersion: input.expectedVersion }))
      }
      if (!canTransitionCredentialStatus(record.status, input.status)) return err(storeFailure('STORE_UNAVAILABLE'))
      const updated = {
        ...record,
        status: input.status,
        version: record.version + 1,
        updatedAt: now
      }
      current.credentials.set(key, updated)
      return ok(cloneRecord(updated))
    }
  }
}
