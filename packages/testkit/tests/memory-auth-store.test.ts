import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createMemoryAuthStore,
  makeProtectedValue,
  makeRawSecret
} from '../src/index.ts'

const createdAt = new Date('2026-01-01T00:00:00.000Z')

test('memory auth store exposes account operations and rejects terminal status reversal', async () => {
  const store = createMemoryAuthStore()
  const created = await store.durable.accounts.create({
    record: accountRecord('account_active', 'active')
  })
  const found = await store.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_active'
  })

  await store.durable.accounts.create({
    record: accountRecord('account_deleted', 'deleted')
  })
  const reversed = await store.durable.accounts.updateStatus({
    tenantId: 'tenant_1',
    accountId: 'account_deleted',
    status: 'active',
    now: createdAt
  })

  assert.equal(created.ok, true)
  assert.equal(found.ok, true)
  assert.equal(found.value.accountId, 'account_active')
  assert.equal(reversed.ok, false)
  assert.equal(reversed.error.reason, 'STORE_UNAVAILABLE')
})

test('memory auth store rejects invalid mutation timestamps without corrupting records', async () => {
  const store = createMemoryAuthStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const created = await store.durable.accounts.create({
    record: {
      tenantId: 'tenant_1',
      accountId: 'account_1',
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
  })
  assert.equal(created.ok, true)

  const updated = await store.durable.accounts.updateStatus({
    tenantId: 'tenant_1',
    accountId: 'account_1',
    status: 'disabled',
    now: new Date('invalid')
  })

  assert.equal(updated.ok, false)
  assert.equal(updated.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(store.__unsafeState.accounts.values().next().value.status, 'active')
  assert.equal(
    store.__unsafeState.accounts.values().next().value.updatedAt.toISOString(),
    now.toISOString()
  )

  const hostileDate = new Proxy(new Date(now), {
    getPrototypeOf() {
      throw new Error('hostile prototype')
    }
  })
  const hostileUpdate = await store.durable.accounts.updateStatus({
    tenantId: 'tenant_1',
    accountId: 'account_1',
    status: 'disabled',
    now: hostileDate
  })

  assert.equal(hostileUpdate.ok, false)
  assert.equal(hostileUpdate.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(store.__unsafeState.accounts.values().next().value.status, 'active')
})

test('memory auth store marks identities verified', async () => {
  const store = createMemoryAuthStore()
  const verifiedAt = new Date('2026-01-01T00:01:00.000Z')
  await store.durable.accounts.create({
    record: accountRecord('account_1', 'active')
  })
  await store.durable.identities.create({
    record: identityRecord()
  })

  const result = await store.durable.identities.markVerified({
    tenantId: 'tenant_1',
    identityId: 'identity_1',
    verifiedAt,
    now: verifiedAt
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.verifiedAt.toISOString(), verifiedAt.toISOString())
  assert.equal(result.value.updatedAt.toISOString(), verifiedAt.toISOString())
})

test('memory auth store updates credential status with an expected version', async () => {
  const store = createMemoryAuthStore()
  const updatedAt = new Date('2026-01-01T00:01:00.000Z')
  await store.durable.accounts.create({
    record: accountRecord('account_1', 'active')
  })
  await store.durable.identities.create({
    record: identityRecord()
  })
  await store.durable.credentials.create({
    record: {
      tenantId: 'tenant_1',
      credentialId: 'credential_1',
      accountId: 'account_1',
      identityId: 'identity_1',
      methodId: 'password.email',
      methodKind: 'password',
      status: 'active',
      material: {
        schemaVersion: 'password.v1',
        privateData: {
          passwordHash: protectedValue('hash')
        }
      },
      version: 1,
      createdAt,
      updatedAt: createdAt
    }
  })

  const result = await store.durable.credentials.updateStatus({
    tenantId: 'tenant_1',
    credentialId: 'credential_1',
    expectedVersion: 1,
    status: 'disabled',
    now: updatedAt
  })
  const stale = await store.durable.credentials.updateStatus({
    tenantId: 'tenant_1',
    credentialId: 'credential_1',
    expectedVersion: 1,
    status: 'active',
    now: updatedAt
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.status, 'disabled')
  assert.equal(result.value.version, 2)
  assert.equal(stale.ok, false)
  assert.equal(stale.error.reason, 'TRANSACTION_FAILED')
})

test('memory auth store keeps expired sessions terminal on revoke', async () => {
  const store = createMemoryAuthStore()
  await store.durable.accounts.create({
    record: accountRecord('account_1', 'active')
  })
  await store.session.sessions.create({
    record: {
      tenantId: 'tenant_1',
      sessionId: 'session_1',
      accountId: 'account_1',
      tokenHash: protectedValue('hash'),
      status: 'expired',
      issuedAt: new Date(createdAt.getTime() - 1000),
      expiresAt: createdAt,
      createdAt,
      updatedAt: createdAt
    }
  })

  const result = await store.session.sessions.revoke({
    tenantId: 'tenant_1',
    sessionId: 'session_1',
    now: new Date(createdAt.getTime() + 1000)
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.status, 'expired')
  assert.equal(result.value.revokedAt, undefined)
})

test('memory auth store records failed challenge attempts with version-aware terminal state', async () => {
  const store = createMemoryAuthStore()
  await store.ephemeral.challenges.create({
    record: challengeRecord({
      challengeId: 'challenge_1',
      maxAttempts: 1
    })
  })

  const recorded = await store.ephemeral.challenges.recordFailedAttempt({
    tenantId: 'tenant_1',
    challengeId: 'challenge_1',
    expectedVersion: 1,
    now: createdAt,
    reason: 'OTP_MISMATCH'
  })
  const stale = await store.ephemeral.challenges.recordFailedAttempt({
    tenantId: 'tenant_1',
    challengeId: 'challenge_1',
    expectedVersion: 1,
    now: createdAt,
    reason: 'OTP_MISMATCH'
  })

  assert.equal(recorded.ok, true)
  assert.equal(recorded.value.status, 'attempts-exceeded')
  assert.equal(recorded.value.challenge.status, 'failed')
  assert.deepEqual(stale, { ok: true, value: { status: 'version-conflict' } })
})

test('memory auth store preserves an already expired challenge', async () => {
  const store = createMemoryAuthStore()
  await store.ephemeral.challenges.create({
    record: challengeRecord({
      challengeId: 'challenge_expired',
      status: 'expired',
      version: 3,
      expiresAt: createdAt
    })
  })
  const now = new Date(createdAt.getTime() + 1000)

  const failedAttempt = await store.ephemeral.challenges.recordFailedAttempt({
    tenantId: 'tenant_1',
    challengeId: 'challenge_expired',
    expectedVersion: 3,
    now,
    reason: 'OTP_MISMATCH'
  })
  const consumed = await store.ephemeral.challenges.consumePending({
    tenantId: 'tenant_1',
    challengeId: 'challenge_expired',
    expectedVersion: 3,
    now
  })
  const found = await store.ephemeral.challenges.findById({
    tenantId: 'tenant_1',
    challengeId: 'challenge_expired'
  })

  assert.equal(failedAttempt.ok, true)
  assert.equal(failedAttempt.value.status, 'expired')
  assert.equal(failedAttempt.value.challenge.version, 3)
  assert.deepEqual(consumed, { ok: true, value: 'expired' })
  assert.equal(found.value.version, 3)
})

test('memory auth store rejects raw and nested secret persistence', async () => {
  const store = createMemoryAuthStore()
  await store.durable.accounts.create({
    record: accountRecord('account_1', 'active')
  })
  await store.durable.identities.create({
    record: identityRecord()
  })

  const raw = await store.durable.credentials.create({
    record: credentialRecord('credential_raw', {
      schemaVersion: 'otp.v1',
      privateData: { code: makeRawSecret('123456') }
    })
  })
  const nested = await store.durable.credentials.create({
    record: credentialRecord('credential_nested', {
      schemaVersion: 'password.v1',
      privateData: {
        nested: { passwordHash: protectedValue('hash') }
      }
    })
  })

  assert.equal(raw.ok, false)
  assert.equal(raw.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(nested.ok, false)
  assert.equal(nested.error.reason, 'STORE_UNAVAILABLE')
})

function accountRecord(accountId: string, status: 'active' | 'deleted') {
  return {
    tenantId: 'tenant_1',
    accountId,
    status,
    createdAt,
    updatedAt: createdAt
  }
}

function identityRecord() {
  return {
    tenantId: 'tenant_1',
    identityId: 'identity_1',
    accountId: 'account_1',
    methodId: 'password.email',
    methodKind: 'password',
    subject: 'user@example.test',
    subjectKind: 'email',
    createdAt,
    updatedAt: createdAt
  }
}

function challengeRecord(overrides: Record<string, unknown>) {
  return {
    tenantId: 'tenant_1',
    challengeId: 'challenge_1',
    methodId: 'otp.email',
    methodKind: 'otp',
    status: 'pending',
    material: { schemaVersion: 'otp.v1' },
    binding: { account: { mode: 'require-existing-identity' } },
    attempts: 0,
    maxAttempts: 3,
    version: 1,
    expiresAt: new Date(createdAt.getTime() + 300000),
    createdAt,
    updatedAt: createdAt,
    ...overrides
  }
}

function credentialRecord(credentialId: string, material: unknown) {
  return {
    tenantId: 'tenant_1',
    credentialId,
    accountId: 'account_1',
    identityId: 'identity_1',
    methodId: 'password.email',
    methodKind: 'password',
    status: 'active',
    material,
    version: 1,
    createdAt,
    updatedAt: createdAt
  }
}

function protectedValue(value: string) {
  return makeProtectedValue({
    scheme: 'test.v1',
    value,
    createdAt
  })
}
