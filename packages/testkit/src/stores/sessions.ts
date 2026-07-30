import type { SessionRecord, SessionStore } from '@authmodules/contracts/store'
import { err, ok } from '../shared/result.ts'
import { storeFailure } from './failure.ts'
import { isSessionRecord } from './record-validation.ts'
import {
  accountKey,
  cloneRecord,
  memoryStateFor,
  sessionKey,
  snapshotDate,
  snapshotRecord,
  tokenHashKey,
  type MemoryState
} from './state.ts'

export function createMemorySessionsStore(state: MemoryState): SessionStore {
  return {
    async create(input, tx) {
      const current = memoryStateFor(state, 'sessions', tx)
      const accounts = memoryStateFor(state, 'accounts', tx)
      if (!current || !accounts) return err(storeFailure('STORE_UNAVAILABLE'))
      const record = snapshotRecord(input.record, isSessionRecord)
      if (!record) return err(storeFailure('STORE_UNAVAILABLE'))
      if (!accounts.accounts.has(accountKey(record.tenantId, record.accountId))) {
        return err(storeFailure('ACCOUNT_NOT_FOUND'))
      }
      const key = sessionKey(record.tenantId, record.sessionId)
      const hashKey = tokenHashKey(record.tenantId, record.tokenHash)
      if (!hashKey) return err(storeFailure('STORE_UNAVAILABLE'))
      if (current.sessions.has(key) || current.sessionsByTokenHash.has(hashKey)) return err(storeFailure('STORE_UNAVAILABLE'))
      current.sessions.set(key, record)
      current.sessionsByTokenHash.set(hashKey, record.sessionId)
      return ok(cloneRecord(record))
    },
    async findById(input, tx) {
      const current = memoryStateFor(state, 'sessions', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      return ok(cloneRecord(current.sessions.get(sessionKey(input.tenantId, input.sessionId))) ?? null)
    },
    async findByTokenHash(input, tx) {
      const current = memoryStateFor(state, 'sessions', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const hashKey = tokenHashKey(input.tenantId, input.tokenHash)
      if (!hashKey) return err(storeFailure('STORE_UNAVAILABLE'))
      const sessionId = current.sessionsByTokenHash.get(hashKey)
      if (!sessionId) {
        return ok(null)
      }
      return ok(cloneRecord(current.sessions.get(sessionKey(input.tenantId, sessionId))) ?? null)
    },
    async revoke(input, tx) {
      const current = memoryStateFor(state, 'sessions', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const now = snapshotDate(input.now)
      if (!now) return err(storeFailure('STORE_UNAVAILABLE'))
      const key = sessionKey(input.tenantId, input.sessionId)
      const record = current.sessions.get(key)
      if (!record) {
        return ok(null)
      }
      if (record.status !== 'active') {
        return ok(cloneRecord(record))
      }
      const updated: SessionRecord = {
        ...record,
        status: 'revoked',
        revokedAt: now,
        updatedAt: new Date(now)
      }
      current.sessions.set(key, updated)
      return ok(cloneRecord(updated))
    },
    async cleanupExpired(input, tx) {
      const current = memoryStateFor(state, 'sessions', tx)
      if (!current) return err(storeFailure('STORE_UNAVAILABLE'))
      const limit = cleanupLimit(input.limit)
      const now = snapshotDate(input.now)
      if (limit === undefined || !now) return err(storeFailure('STORE_UNAVAILABLE'))
      let count = 0
      for (const [key, record] of current.sessions) {
        if (record.tenantId !== input.tenantId || record.status !== 'active' || record.expiresAt > now) {
          continue
        }
        if (count >= limit) {
          break
        }
        current.sessions.set(key, {
          ...record,
          status: 'expired',
          updatedAt: new Date(now)
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
