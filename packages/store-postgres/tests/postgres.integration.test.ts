import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { createPostgresAuthOutboxStores, createPostgresAuthStore, installPostgresSchema } from '../src/index.ts'

const databaseUrl = process.env.AUTHMODULES_POSTGRES_URL

test('real PostgreSQL enforces transactions, tenant isolation, uniqueness, concurrency, and cleanup limits', {
  skip: databaseUrl ? false : 'AUTHMODULES_POSTGRES_URL is not configured'
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const client = postgresClient(pool)
  try {
    await resetSchema(pool)
    await installLegacyOutboxSchema(pool)
    await pool.query(`insert into authmodules_outbox (
      tenant_id, message_id, context, secret_purpose, type, message, dispatch_policy, status,
      attempts, max_attempts, idempotency_key, available_at, created_at, updated_at
    ) values (
      'tenant_legacy', 'message_legacy', '{"tenantId":"tenant_legacy"}',
      '["authmodules.outbox.delivery","tenant_legacy","message_legacy"]',
      'delivery', '{"to":{"channel":"email","target":"user@example.test"},"templateId":"otp"}',
      'required', 'pending', 0, 3, null, now(), now(), now()
    )`)
    await installPostgresSchema(client)
    const migrated = await pool.query(
      'select idempotency_key, last_failure_reason from authmodules_outbox where tenant_id = $1',
      ['tenant_legacy']
    )
    assert.deepEqual(migrated.rows[0], {
      idempotency_key: 'message_legacy',
      last_failure_reason: null
    })
    await assert.rejects(
      pool.query(`insert into authmodules_outbox (
        tenant_id, message_id, context, secret_purpose, type, message, dispatch_policy, status,
        attempts, max_attempts, idempotency_key, available_at, created_at, updated_at
      ) values (
        'tenant_legacy', 'message_invalid', '{"tenantId":"tenant_legacy"}',
        '["authmodules.outbox.delivery","tenant_legacy","message_invalid"]',
        'delivery', '{"to":{"channel":"email","target":"user@example.test"},"templateId":"otp"}',
        'required', 'pending', 0, 3, null, now(), now(), now()
      )`)
    )
    await installPostgresSchema(client)

    await resetSchema(pool)
    await installPostgresSchema(client)
    await installPostgresSchema(client)
    const store = createPostgresAuthStore({ client })
    const atomicStores = createPostgresAuthOutboxStores({ client })
    const now = new Date('2026-01-01T00:00:00.000Z')

    const rolledBack = await store.transaction.run({ requiredScopes: ['accounts'] }, async (tx) => {
      const created = await store.durable.accounts.create({
        record: accountRecord('tenant_rollback', 'account_rollback', now)
      }, tx)
      assert.equal(created.ok, true)
      return {
        ok: false,
        error: { type: 'component.failure', component: 'test', reason: 'EXPECTED_ROLLBACK' }
      }
    })
    assert.equal(rolledBack.ok, false)
    assert.equal((await store.durable.accounts.findById({
      tenantId: 'tenant_rollback',
      accountId: 'account_rollback'
    })).value, null)

    const outboxRollback = await atomicStores.auth.transaction.run(
      { requiredScopes: ['accounts', 'outbox'] },
      async (tx) => {
      assert.equal(tx.covers.includes('outbox'), true)
      const created = await atomicStores.auth.durable.accounts.create({
        record: accountRecord('tenant_outbox_rollback', 'account_outbox_rollback', now)
      }, tx)
      assert.equal(created.ok, true)
      const enqueued = await atomicStores.outbox.enqueue({ message: outboxRecord(now, 'rollback') }, tx)
      assert.equal(enqueued.ok, true)
      return {
        ok: false,
        error: { type: 'component.failure', component: 'test', reason: 'EXPECTED_ROLLBACK' }
      }
      }
    )
    assert.equal(outboxRollback.ok, false)
    assert.equal((await pool.query(
      'select count(*)::int as count from authmodules_outbox where tenant_id = $1',
      ['tenant_outbox_rollback']
    )).rows[0].count, 0)

    const outboxCommit = await atomicStores.auth.transaction.run({ requiredScopes: ['outbox'] }, async (tx) => {
      const enqueued = await atomicStores.outbox.enqueue({ message: outboxRecord(now, 'commit') }, tx)
      return enqueued.ok ? { ok: true, value: undefined } : enqueued
    })
    assert.equal(outboxCommit.ok, true)
    const claimed = await atomicStores.outbox.claimBatch({
      now,
      limit: 1,
      workerId: 'worker_1',
      leaseSeconds: 30,
      tenantId: 'tenant_outbox_commit'
    })
    assert.equal(claimed.ok, true)
    assert.equal(claimed.value.length, 1)
    assert.equal(claimed.value[0].messageId, 'message_commit')
    assert.equal((await atomicStores.outbox.markDispatched({
      tenantId: claimed.value[0].tenantId,
      messageId: claimed.value[0].messageId,
      workerId: 'worker_1',
      leaseId: claimed.value[0].lease.leaseId,
      now
    })).ok, true)

    const batchTenant = 'tenant_outbox_batch'
    const batch = await atomicStores.outbox.enqueueBatch({
      messages: [
        outboxRecordForTenant(now, batchTenant, 'batch_first'),
        outboxRecordForTenant(now, batchTenant, 'batch_second')
      ]
    })
    assert.equal(batch.ok, true)
    assert.deepEqual(batch.value.map((message) => message.messageId), ['message_batch_first', 'message_batch_second'])

    const concurrentClaimTenant = 'tenant_outbox_concurrent_claim'
    const concurrentMessages = Array.from({ length: 4 }, (_, index) => (
      outboxRecordForTenant(now, concurrentClaimTenant, `concurrent_${index + 1}`)
    ))
    assert.equal((await atomicStores.outbox.enqueueBatch({ messages: concurrentMessages })).ok, true)
    const concurrentClaims = await Promise.all([
      atomicStores.outbox.claimBatch({
        now,
        limit: 2,
        workerId: 'worker_concurrent_a',
        leaseSeconds: 30,
        tenantId: concurrentClaimTenant
      }),
      atomicStores.outbox.claimBatch({
        now,
        limit: 2,
        workerId: 'worker_concurrent_b',
        leaseSeconds: 30,
        tenantId: concurrentClaimTenant
      })
    ])
    assert.equal(concurrentClaims.every((result) => result.ok), true)
    assert.equal(concurrentClaims.every((result) => result.value.length === 2), true)
    const claimedIds = concurrentClaims.flatMap((result) => (
      result.value.map((message) => message.messageId)
    ))
    assert.equal(new Set(claimedIds).size, 4)
    assert.deepEqual(new Set(claimedIds), new Set(concurrentMessages.map((message) => message.messageId)))
    assert.equal(
      concurrentClaims[0].value.every((message) => message.lease.workerId === 'worker_concurrent_a'),
      true
    )
    assert.equal(
      concurrentClaims[1].value.every((message) => message.lease.workerId === 'worker_concurrent_b'),
      true
    )

    const idempotentOriginal = outboxRecordForTenant(now, batchTenant, 'idempotent_original')
    assert.equal((await atomicStores.outbox.enqueue({ message: idempotentOriginal })).ok, true)
    const idempotentDuplicate = await atomicStores.outbox.enqueue({
      message: {
        ...idempotentOriginal,
        messageId: 'message_idempotent_duplicate',
        secretPurpose: JSON.stringify([
          'authmodules.outbox.delivery',
          batchTenant,
          'message_idempotent_duplicate'
        ]),
        message: {
          ...idempotentOriginal.message,
          to: { ...idempotentOriginal.message.to, target: 'attacker@example.test' }
        }
      }
    })
    assert.equal(idempotentDuplicate.ok, true)
    assert.equal(idempotentDuplicate.value.messageId, idempotentOriginal.messageId)
    assert.equal(idempotentDuplicate.value.message.to.target, idempotentOriginal.message.to.target)

    const existing = outboxRecordForTenant(now, batchTenant, 'existing')
    assert.equal((await atomicStores.outbox.enqueue({ message: existing })).ok, true)
    const atomicFailure = await atomicStores.outbox.enqueueBatch({
      messages: [
        outboxRecordForTenant(now, batchTenant, 'must_roll_back'),
        {
          ...outboxRecordForTenant(now, batchTenant, 'primary_key_conflict'),
          messageId: existing.messageId
        }
      ]
    })
    assert.equal(atomicFailure.ok, false)
    assert.equal((await pool.query(
      'select count(*)::int as count from authmodules_outbox where tenant_id = $1 and message_id = $2',
      [batchTenant, 'message_must_roll_back']
    )).rows[0].count, 0)

    const leaseTenant = 'tenant_outbox_lease'
    assert.equal((await atomicStores.outbox.enqueue({
      message: outboxRecordForTenant(now, leaseTenant, 'renewed')
    })).ok, true)
    const leased = await atomicStores.outbox.claimBatch({
      now,
      limit: 1,
      workerId: 'worker_renew',
      leaseSeconds: 10,
      tenantId: leaseTenant
    })
    const renewedAt = new Date(now.getTime() + 1000)
    const renewed = await atomicStores.outbox.renewLease({
      tenantId: leaseTenant,
      messageId: leased.value[0].messageId,
      workerId: 'worker_renew',
      leaseId: leased.value[0].lease.leaseId,
      now: renewedAt,
      leaseSeconds: 20
    })
    assert.equal(renewed.ok, true)
    assert.equal(renewed.value.leaseUntil.toISOString(), new Date(now.getTime() + 21000).toISOString())
    const dispatchedAt = new Date(now.getTime() + 2000)
    assert.equal((await atomicStores.outbox.markDispatched({
      tenantId: leaseTenant,
      messageId: leased.value[0].messageId,
      workerId: 'worker_renew',
      leaseId: leased.value[0].lease.leaseId,
      now: dispatchedAt
    })).ok, true)
    assert.deepEqual(await atomicStores.outbox.cleanupTerminal({
      before: dispatchedAt,
      statuses: ['dispatched'],
      limit: 1,
      tenantId: leaseTenant
    }), { ok: true, value: 1 })
    const reusedIdempotency = await atomicStores.outbox.enqueue({
      message: {
        ...outboxRecordForTenant(now, leaseTenant, 'renewed_after_cleanup'),
        idempotencyKey: 'delivery_renewed'
      }
    })
    assert.equal(reusedIdempotency.ok, true)
    assert.equal(reusedIdempotency.value.messageId, 'message_renewed_after_cleanup')

    const failureTenant = 'tenant_outbox_failure_reason'
    assert.equal((await atomicStores.outbox.enqueue({
      message: outboxRecordForTenant(now, failureTenant, 'failure_reason')
    })).ok, true)
    const failureClaim = await atomicStores.outbox.claimBatch({
      now,
      limit: 1,
      workerId: 'worker_failure',
      leaseSeconds: 30,
      tenantId: failureTenant
    })
    assert.equal((await atomicStores.outbox.markFailed({
      tenantId: failureTenant,
      messageId: failureClaim.value[0].messageId,
      workerId: 'worker_failure',
      leaseId: failureClaim.value[0].lease.leaseId,
      now,
      reason: 'DELIVERY_FAILED',
      retryAt: new Date(now.getTime() + 1000)
    })).ok, true)
    assert.deepEqual((await pool.query(
      'select status, last_failure_reason from authmodules_outbox where tenant_id = $1',
      [failureTenant]
    )).rows[0], { status: 'failed', last_failure_reason: 'DELIVERY_FAILED' })

    const reclaimTenant = 'tenant_outbox_reclaim'
    assert.equal((await atomicStores.outbox.enqueue({
      message: outboxRecordForTenant(now, reclaimTenant, 'final_attempt', 1)
    })).ok, true)
    await atomicStores.outbox.claimBatch({
      now,
      limit: 1,
      workerId: 'worker_abandoned',
      leaseSeconds: 1,
      tenantId: reclaimTenant
    })
    const reclaimed = await atomicStores.outbox.claimBatch({
      now: new Date(now.getTime() + 1000),
      limit: 1,
      workerId: 'worker_reclaimer',
      leaseSeconds: 1,
      tenantId: reclaimTenant
    })
    assert.deepEqual(reclaimed, { ok: true, value: [] })
    assert.deepEqual((await pool.query(
      'select status, attempts from authmodules_outbox where tenant_id = $1',
      [reclaimTenant]
    )).rows[0], { status: 'dead', attempts: 1 })

    const thrownRollback = await store.transaction.run({ requiredScopes: ['accounts'] }, async (tx) => {
      const created = await store.durable.accounts.create({
        record: accountRecord('tenant_throw', 'account_throw', now)
      }, tx)
      assert.equal(created.ok, true)
      throw new Error('expected transaction rollback')
    })
    assert.equal(thrownRollback.ok, false)
    assert.equal(thrownRollback.error.reason, 'TRANSACTION_FAILED')
    assert.equal((await store.durable.accounts.findById({
      tenantId: 'tenant_throw',
      accountId: 'account_throw'
    })).value, null)

    await store.durable.accounts.create({ record: accountRecord('tenant_a', 'account_1', now) })
    const isolated = await store.durable.accounts.findById({ tenantId: 'tenant_b', accountId: 'account_1' })
    assert.deepEqual(isolated, { ok: true, value: null })

    const identity = identityRecord(now)
    assert.equal((await store.durable.identities.create({ record: identity })).ok, true)
    const duplicateIdentity = await store.durable.identities.create({
      record: { ...identity, identityId: 'identity_2' }
    })
    assert.equal(duplicateIdentity.ok, false)
    assert.equal(duplicateIdentity.error.reason, 'IDENTITY_CONFLICT')

    const credential = credentialRecord(now)
    assert.equal((await store.durable.credentials.create({ record: credential })).ok, true)
    const duplicateCredential = await store.durable.credentials.create({
      record: { ...credential, credentialId: 'credential_2' }
    })
    assert.equal(duplicateCredential.ok, false)
    assert.equal(duplicateCredential.error.reason, 'CREDENTIAL_CONFLICT')

    await store.durable.accounts.create({ record: accountRecord('tenant_a', 'account_2', now) })
    const backupIdentity = {
      ...identity,
      identityId: 'identity_backup',
      methodId: 'password.backup',
      subject: 'backup@example.test'
    }
    assert.equal((await store.durable.identities.create({ record: backupIdentity })).ok, true)
    const crossAccountCredential = await store.durable.credentials.create({
      record: {
        ...credential,
        credentialId: 'credential_cross_account',
        accountId: 'account_2',
        identityId: backupIdentity.identityId,
        methodId: backupIdentity.methodId
      }
    })
    assert.equal(crossAccountCredential.ok, false)

    const challenge = challengeRecord(now)
    assert.equal((await store.ephemeral.challenges.create({ record: challenge })).ok, true)
    const { consumePending } = store.ephemeral.challenges
    const consume = () => store.transaction.run({ requiredScopes: ['challenges'] }, async (tx) => {
      const found = await store.ephemeral.challenges.findById({
        tenantId: challenge.tenantId,
        challengeId: challenge.challengeId
      }, tx)
      if (!found.ok) return found
      return consumePending({
        tenantId: challenge.tenantId,
        challengeId: challenge.challengeId,
        expectedVersion: found.value.version,
        now: new Date(now.getTime() + 1000)
      }, tx)
    })
    const concurrent = await Promise.all([consume(), consume()])
    const outcomes = concurrent.map((result) => result.value)
    assert.equal(outcomes.filter((value) => value === 'consumed').length, 1)
    assert.equal(outcomes.every((value) => ['consumed', 'already-consumed', 'version-conflict'].includes(value)), true)

    for (let index = 1; index <= 3; index += 1) {
      await store.session.sessions.create({
        record: sessionRecord(index, now)
      })
    }
    await store.session.sessions.create({ record: sessionRecord(4, now) })
    const { revoke } = store.session.sessions
    const revoked = await revoke({
      tenantId: 'tenant_a',
      sessionId: 'session_4',
      now
    })
    assert.equal(revoked.ok, true)
    assert.equal(revoked.value.status, 'revoked')
    const tokenLookup = await store.session.sessions.findByTokenHash({
      tenantId: 'tenant_a',
      tokenHash: protectedValue('token-hash-1', {
        keyId: 'primary',
        createdAt: new Date(now.getTime() + 5000)
      })
    })
    const wrongSchemeLookup = await store.session.sessions.findByTokenHash({
      tenantId: 'tenant_a',
      tokenHash: protectedValue('token-hash-1', { scheme: 'other.v1', keyId: 'primary' })
    })
    const wrongKeyLookup = await store.session.sessions.findByTokenHash({
      tenantId: 'tenant_a',
      tokenHash: protectedValue('token-hash-1', { keyId: 'secondary' })
    })
    assert.equal(tokenLookup.value.sessionId, 'session_1')
    assert.equal(wrongSchemeLookup.value, null)
    assert.equal(wrongKeyLookup.value, null)

    const cleaned = await store.session.sessions.cleanupExpired({
      tenantId: 'tenant_a',
      now: new Date(now.getTime() + 120000),
      limit: 2
    })
    assert.deepEqual(cleaned, { ok: true, value: 2 })
    const remaining = await pool.query(
      "select count(*)::int as count from authmodules_sessions where tenant_id = $1 and status = 'active'",
      ['tenant_a']
    )
    assert.equal(remaining.rows[0].count, 1)
  } finally {
    await pool.end()
  }
})

function postgresClient(pool) {
  return {
    query(sql, params) {
      return pool.query(sql, params)
    },
    async transaction(fn) {
      const connection = await pool.connect()
      try {
        await connection.query('begin')
        const result = await fn(connection)
        await connection.query('commit')
        return result
      } catch (error) {
        await connection.query('rollback')
        throw error
      } finally {
        connection.release()
      }
    }
  }
}

async function resetSchema(pool) {
  await pool.query(`
    drop table if exists authmodules_outbox;
    drop table if exists authmodules_challenges;
    drop table if exists authmodules_sessions;
    drop table if exists authmodules_credentials;
    drop table if exists authmodules_identities;
    drop table if exists authmodules_accounts;
  `)
}

async function installLegacyOutboxSchema(pool) {
  await pool.query(`
    create table authmodules_outbox (
      tenant_id text not null,
      message_id text not null,
      context jsonb not null,
      secret_purpose text not null,
      type text not null,
      message jsonb not null,
      dispatch_policy text not null,
      status text not null,
      attempts integer not null,
      max_attempts integer not null,
      idempotency_key text,
      expires_at timestamptz,
      available_at timestamptz not null,
      lease_id text,
      worker_id text,
      lease_until timestamptz,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      constraint authmodules_outbox_pkey primary key (tenant_id, message_id),
      check (type = 'delivery'),
      check (dispatch_policy in ('required', 'best-effort')),
      check (status in ('pending', 'claimed', 'dispatched', 'failed', 'dead')),
      check (attempts >= 0),
      check (max_attempts > 0),
      check (attempts <= max_attempts),
      check ((status = 'claimed') = (
        lease_id is not null and worker_id is not null and lease_until is not null
      ))
    );

    create unique index authmodules_outbox_idempotency_uniq
      on authmodules_outbox (tenant_id, idempotency_key)
      where idempotency_key is not null;
  `)
}

function outboxRecord(now, suffix) {
  return outboxRecordForTenant(now, `tenant_outbox_${suffix}`, suffix)
}

function outboxRecordForTenant(now, tenantId, suffix, maxAttempts = 3) {
  return {
    tenantId,
    messageId: `message_${suffix}`,
    context: { tenantId },
    secretPurpose: JSON.stringify(['authmodules.outbox.delivery', tenantId, `message_${suffix}`]),
    type: 'delivery',
    message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
    dispatchPolicy: 'required',
    status: 'pending',
    attempts: 0,
    maxAttempts,
    idempotencyKey: `delivery_${suffix}`,
    availableAt: now,
    createdAt: now,
    updatedAt: now
  }
}

function accountRecord(tenantId, accountId, now) {
  return { tenantId, accountId, status: 'active', createdAt: now, updatedAt: now }
}

function identityRecord(now) {
  return {
    tenantId: 'tenant_a',
    identityId: 'identity_1',
    accountId: 'account_1',
    methodId: 'password.email',
    methodKind: 'password',
    subject: 'user@example.test',
    subjectKind: 'email',
    createdAt: now,
    updatedAt: now
  }
}

function credentialRecord(now) {
  return {
    tenantId: 'tenant_a',
    credentialId: 'credential_1',
    accountId: 'account_1',
    identityId: 'identity_1',
    methodId: 'password.email',
    methodKind: 'password',
    status: 'active',
    material: {
      schemaVersion: 'password.v1',
      privateData: { passwordHash: protectedValue('password-hash') }
    },
    version: 1,
    createdAt: now,
    updatedAt: now
  }
}

function challengeRecord(now) {
  return {
    tenantId: 'tenant_a',
    challengeId: 'challenge_1',
    methodId: 'otp.email',
    methodKind: 'otp',
    lookup: {
      methodId: 'otp.email',
      methodKind: 'otp',
      subject: 'user@example.test',
      subjectKind: 'email'
    },
    status: 'pending',
    material: {
      schemaVersion: 'otp.v1',
      privateData: { codeHash: protectedValue('otp-hash') }
    },
    binding: { account: { mode: 'require-existing-identity' } },
    attempts: 0,
    maxAttempts: 3,
    version: 1,
    expiresAt: new Date(now.getTime() + 60000),
    createdAt: now,
    updatedAt: now
  }
}

function sessionRecord(index, now) {
  return {
    tenantId: 'tenant_a',
    sessionId: `session_${index}`,
    accountId: 'account_1',
    tokenHash: protectedValue(`token-hash-${index}`, { keyId: 'primary', createdAt: now }),
    status: 'active',
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 60000),
    createdAt: now,
    updatedAt: now
  }
}

function protectedValue(value, options = {}) {
  return {
    type: 'protected-value',
    scheme: options.scheme ?? 'test.v1',
    keyId: options.keyId,
    createdAt: options.createdAt,
    redacted: '[REDACTED]',
    revealForPersistence() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}
