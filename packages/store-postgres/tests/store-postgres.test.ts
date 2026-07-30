import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPostgresAuthOutboxStores,
  createPostgresAuthStore,
  installPostgresSchema,
  postgresSchemaSql
} from '../src/index.ts'

test('schema contains the core AuthModules tables', () => {
  assert.equal(postgresSchemaSql.includes('authmodules_accounts'), true)
  assert.equal(postgresSchemaSql.includes('authmodules_identities'), true)
  assert.equal(postgresSchemaSql.includes('authmodules_sessions'), true)
  assert.equal(postgresSchemaSql.includes('authmodules_challenges'), true)
  assert.equal(postgresSchemaSql.includes('authmodules_outbox'), true)
  assert.equal(postgresSchemaSql.includes('foreign key (tenant_id, account_id)'), true)
  assert.equal(postgresSchemaSql.includes('foreign key (tenant_id, identity_id, account_id, method_id, method_kind)'), true)
  assert.equal(postgresSchemaSql.includes('unique (tenant_id, identity_id, method_id)'), true)
  assert.equal(postgresSchemaSql.includes('token_hash_scheme text not null'), true)
  assert.equal(postgresSchemaSql.includes('token_hash_key_id text not null'), true)
  assert.equal(postgresSchemaSql.includes('token_hash_value text not null'), true)
  assert.equal(postgresSchemaSql.includes('token_hash_scheme,\n    token_hash_key_id,\n    token_hash_value'), true)
  assert.equal(postgresSchemaSql.includes("token_hash ->> 'value' = token_hash_value"), true)
  assert.equal(postgresSchemaSql.includes('for update skip locked'), false)
  assert.equal(postgresSchemaSql.includes('authmodules_outbox_expiry_idx'), true)
  assert.equal(postgresSchemaSql.includes('authmodules_outbox_claimed_lease_idx'), true)
})

test('installPostgresSchema sends schema SQL to provided client', async () => {
  const calls = []
  const client = {
    async query(sql) {
      calls.push(sql)
      return { rows: [] }
    }
  }

  await installPostgresSchema(client)

  assert.deepEqual(calls, [postgresSchemaSql])
})

test('postgres store rejects session and challenge invariant violations before querying', async () => {
  let queries = 0
  const store = createPostgresAuthStore({
    client: {
      async query() {
        queries += 1
        return { rows: [] }
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const session = await store.session.sessions.create({
    record: {
      tenantId: 'tenant_1',
      sessionId: 'session_invalid',
      accountId: 'account_1',
      tokenHash: protectedValue('hash'),
      status: 'active',
      issuedAt: now,
      expiresAt: now,
      createdAt: now,
      updatedAt: now
    }
  })
  const challenge = await store.ephemeral.challenges.create({
    record: {
      tenantId: 'tenant_1',
      challengeId: 'challenge_invalid',
      methodId: 'otp',
      methodKind: 'otp',
      status: 'consumed',
      material: { schemaVersion: 'otp.v1' },
      binding: { account: { mode: 'create-new-account' } },
      attempts: 0,
      maxAttempts: 3,
      version: 1,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now
    }
  })
  const invalidBindingTtl = await store.ephemeral.challenges.create({
    record: {
      tenantId: 'tenant_1',
      challengeId: 'challenge_invalid_ttl',
      methodId: 'otp',
      methodKind: 'otp',
      status: 'pending',
      material: { schemaVersion: 'otp.v1' },
      binding: {
        account: { mode: 'create-new-account' },
        session: { ttlSeconds: 0 }
      },
      attempts: 0,
      maxAttempts: 3,
      version: 1,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now
    }
  })

  assert.equal(session.ok, false)
  assert.equal(challenge.ok, false)
  assert.equal(invalidBindingTtl.ok, false)
  assert.equal(queries, 0)
})


test('client-backed postgres store maps raw secret persistence to store failure', async () => {
  const store = createPostgresAuthStore({
    client: {
      async query() {
        throw new Error('query should not be called')
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')

  const result = await store.durable.credentials.create({
    record: {
      tenantId: 'tenant_1',
      credentialId: 'credential_1',
      accountId: 'account_1',
      identityId: 'identity_1',
      methodId: 'otp.email',
      methodKind: 'otp',
      status: 'active',
      material: {
        schemaVersion: 'otp.v1',
        privateData: {
          code: rawSecret('123456')
        }
      },
      version: 1,
      createdAt: now,
      updatedAt: now
    }
  })
  const nested = await store.durable.credentials.create({
    record: {
      tenantId: 'tenant_1',
      credentialId: 'credential_nested',
      accountId: 'account_1',
      identityId: 'identity_1',
      methodId: 'password.email',
      methodKind: 'password',
      status: 'active',
      material: {
        schemaVersion: 'password.v1',
        privateData: {
          nested: { passwordHash: protectedValue('hash') }
        }
      },
      version: 1,
      createdAt: now,
      updatedAt: now
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(nested.ok, false)
  assert.equal(nested.error.reason, 'STORE_UNAVAILABLE')
})

test('client-backed postgres store maps cyclic JSON input to store failure without querying', async () => {
  let queries = 0
  const store = createPostgresAuthStore({
    client: {
      async query() {
        queries += 1
        return { rows: [] }
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const cyclic = {}
  cyclic.self = cyclic

  const account = await store.durable.accounts.create({
    record: {
      tenantId: 'tenant_1',
      accountId: 'account_1',
      status: 'active',
      publicData: cyclic,
      createdAt: now,
      updatedAt: now
    }
  })
  const disguisedSecret = await store.durable.accounts.create({
    record: {
      tenantId: 'tenant_1',
      accountId: 'account_secret',
      status: 'active',
      publicData: {
        verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
      },
      createdAt: now,
      updatedAt: now
    }
  })
  const challenge = await store.ephemeral.challenges.create({
    record: {
      tenantId: 'tenant_1',
      challengeId: 'challenge_1',
      methodId: 'otp.email',
      methodKind: 'otp',
      status: 'pending',
      material: { schemaVersion: 'otp.v1' },
      binding: cyclic,
      attempts: 0,
      maxAttempts: 3,
      version: 1,
      expiresAt: new Date(now.getTime() + 300000),
      createdAt: now,
      updatedAt: now
    }
  })
  const invalidIdentity = await store.durable.identities.create({
    record: {
      tenantId: 'tenant_1',
      identityId: 'identity_invalid',
      accountId: 'account_1',
      methodId: 'password.email',
      methodKind: 'password',
      subject: 'user@example.test',
      subjectKind: 'email',
      createdAt: now,
      updatedAt: new Date(Number.NaN)
    }
  })

  assert.equal(account.ok, false)
  assert.equal(account.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(disguisedSecret.ok, false)
  assert.equal(disguisedSecret.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(challenge.ok, false)
  assert.equal(challenge.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(invalidIdentity.ok, false)
  assert.equal(invalidIdentity.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(queries, 0)
})

test('client-backed postgres store maps unique identity and credential races to conflicts', async () => {
  const errors = [
    Object.assign(new Error('duplicate identity'), {
      code: '23505',
      constraint: 'authmodules_identities_subject_uniq'
    }),
    Object.assign(new Error('duplicate credential'), {
      code: '23505',
      constraint: 'authmodules_credentials_identity_method_uniq'
    })
  ]
  const store = createPostgresAuthStore({
    client: {
      async query() {
        throw errors.shift()
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const identity = await store.durable.identities.create({
    record: {
      tenantId: 'tenant_1',
      identityId: 'identity_1',
      accountId: 'account_1',
      methodId: 'password.email',
      methodKind: 'password',
      subject: 'user@example.test',
      subjectKind: 'email',
      createdAt: now,
      updatedAt: now
    }
  })
  const credential = await store.durable.credentials.create({
    record: {
      tenantId: 'tenant_1',
      credentialId: 'credential_1',
      accountId: 'account_1',
      identityId: 'identity_1',
      methodId: 'password.email',
      methodKind: 'password',
      status: 'active',
      material: { schemaVersion: 'password.v1' },
      version: 1,
      createdAt: now,
      updatedAt: now
    }
  })

  assert.equal(identity.error.reason, 'IDENTITY_CONFLICT')
  assert.equal(credential.error.reason, 'CREDENTIAL_CONFLICT')
})

test('client-backed identity lookups remain tenant and method scoped', async () => {
  const calls = []
  const store = createPostgresAuthStore({
    client: {
      async query(sql, params) {
        calls.push({ sql, params })
        return { rows: [] }
      }
    }
  })

  const byId = await store.durable.identities.findById({
    tenantId: 'tenant_1',
    identityId: 'identity_1'
  })
  const bySubject = await store.durable.identities.findBySubject({
    tenantId: 'tenant_1',
    methodId: 'password.email',
    subject: 'user@example.test'
  })

  assert.deepEqual(byId, { ok: true, value: null })
  assert.deepEqual(bySubject, { ok: true, value: null })
  assert.equal(calls[0].sql.includes('tenant_id = $1 and identity_id = $2'), true)
  assert.deepEqual(calls[0].params, ['tenant_1', 'identity_1'])
  assert.equal(calls[1].sql.includes('tenant_id = $1 and method_id = $2 and subject = $3'), true)
  assert.deepEqual(calls[1].params, ['tenant_1', 'password.email', 'user@example.test'])
})

test('client-backed postgres store guards terminal status transitions in SQL', async () => {
  const calls = []
  const store = createPostgresAuthStore({
    client: {
      async query(sql, params) {
        calls.push({ sql, params })
        return { rows: [] }
      }
    }
  })

  await store.durable.accounts.updateStatus({
    tenantId: 'tenant_1',
    accountId: 'account_1',
    status: 'active',
    now: new Date('2026-01-01T00:00:00.000Z')
  })
  await store.durable.credentials.updateStatus({
    tenantId: 'tenant_1',
    credentialId: 'credential_1',
    expectedVersion: 1,
    status: 'disabled',
    now: new Date('2026-01-01T00:00:00.000Z')
  })

  assert.equal(calls[0].sql.includes("status = 'active'"), true)
  assert.equal(calls[0].sql.includes("status = 'disabled'"), true)
  assert.equal(calls[1].sql.includes('version = $3'), true)
  assert.equal(calls[1].sql.includes("status = 'active'"), true)
})

test('client-backed credential updates distinguish missing, stale, and invalid transitions', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const credentialRow = {
    tenant_id: 'tenant_1',
    credential_id: 'credential_1',
    account_id: 'account_1',
    identity_id: 'identity_1',
    method_id: 'password.email',
    method_kind: 'password',
    status: 'active',
    material: { schemaVersion: 'password.v1' },
    version: 2,
    created_at: now,
    updated_at: now
  }
  const responses = [
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [credentialRow] },
    { rows: [] },
    { rows: [{ ...credentialRow, version: 1 }] }
  ]
  const store = createPostgresAuthStore({
    client: {
      async query() {
        return responses.shift()
      }
    }
  })

  const missing = await store.durable.credentials.updateStatus({
    tenantId: 'tenant_1',
    credentialId: 'missing',
    expectedVersion: 1,
    status: 'disabled',
    now
  })
  const stale = await store.durable.credentials.updateStatus({
    tenantId: 'tenant_1',
    credentialId: 'credential_1',
    expectedVersion: 1,
    status: 'disabled',
    now
  })
  const invalidTransition = await store.durable.credentials.updateStatus({
    tenantId: 'tenant_1',
    credentialId: 'credential_1',
    expectedVersion: 1,
    status: 'disabled',
    now
  })

  assert.equal(missing.ok, false)
  assert.equal(missing.error.reason, 'CREDENTIAL_NOT_FOUND')
  assert.equal(stale.ok, false)
  assert.equal(stale.error.reason, 'TRANSACTION_FAILED')
  assert.equal(invalidTransition.ok, false)
  assert.equal(invalidTransition.error.reason, 'STORE_UNAVAILABLE')
})

test('client-backed postgres challenge expiry update is pending guarded', async () => {
  const calls = []
  const now = new Date('2026-01-01T00:05:00.000Z')
  const store = createPostgresAuthStore({
    client: {
      async query(sql, params) {
        calls.push({ sql, params })
        if (calls.length === 1) {
          return {
            rows: [{
              tenant_id: 'tenant_1',
              challenge_id: 'challenge_1',
              method_id: 'otp.email',
              method_kind: 'otp',
              lookup: null,
              status: 'pending',
              material: { schemaVersion: 'otp.v1' },
              binding: { account: { mode: 'require-existing-identity' } },
              attempts: 0,
              max_attempts: 3,
              version: 1,
              expires_at: new Date('2026-01-01T00:00:00.000Z'),
              consumed_at: null,
              created_at: new Date('2026-01-01T00:00:00.000Z'),
              updated_at: new Date('2026-01-01T00:00:00.000Z')
            }]
          }
        }
        return { rows: [] }
      }
    }
  })

  const result = await store.ephemeral.challenges.recordFailedAttempt({
    tenantId: 'tenant_1',
    challengeId: 'challenge_1',
    expectedVersion: 1,
    now,
    reason: 'OTP_MISMATCH'
  })

  assert.deepEqual(result, { ok: true, value: { status: 'version-conflict' } })
  assert.equal(calls[1].sql.includes("status = 'pending'"), true)
})

test('createPostgresAuthStore requires a client and exposes transactions only through a provider', () => {
  assert.throws(() => createPostgresAuthStore(), /requires a PostgreSQL client/)
  assert.throws(
    () => createPostgresAuthStore({ client: { query() {}, transaction: true } }),
    /client\.transaction/
  )
  assert.throws(
    () => createPostgresAuthStore({ client: { query() {} }, secretFactory: {} }),
    /secretFactory/
  )

  const store = createPostgresAuthStore({
    client: {
      async query() {
        return { rows: [] }
      }
    }
  })

  assert.equal(store.transaction, undefined)
})

test('client-backed store maps malformed provider results and rows to store failures', async () => {
  const malformedResult = createPostgresAuthStore({
    client: {
      async query() {
        return undefined
      }
    }
  })
  const missingResult = await malformedResult.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_1'
  })
  assert.equal(missingResult.ok, false)
  assert.equal(missingResult.error.reason, 'STORE_UNAVAILABLE')

  const malformedRow = createPostgresAuthStore({
    client: {
      async query() {
        return {
          rows: [{
            tenant_id: 'tenant_1',
            account_id: 'account_1',
            status: 'active',
            created_at: 'not-a-date',
            updated_at: 'not-a-date'
          }]
        }
      }
    }
  })
  const invalidRow = await malformedRow.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_1'
  })
  assert.equal(invalidRow.ok, false)
  assert.equal(invalidRow.error.reason, 'STORE_UNAVAILABLE')

  const secretRow = createPostgresAuthStore({
    client: {
      async query() {
        return {
          rows: [{
            tenant_id: 'tenant_1',
            account_id: 'account_secret',
            status: 'active',
            public_data: {
              verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
            },
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z'
          }]
        }
      }
    }
  })
  const invalidSecretRow = await secretRow.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_secret'
  })
  assert.equal(invalidSecretRow.ok, false)
  assert.equal(invalidSecretRow.error.reason, 'STORE_UNAVAILABLE')
})

test('transaction provider must execute and return a valid Result', async () => {
  const skipped = createPostgresAuthStore({
    client: {
      async query() {
        return { rows: [] }
      },
      async transaction() {
        return undefined
      }
    }
  })
  const skippedResult = await skipped.transaction.run(
    { requiredScopes: ['accounts'] },
    async () => ({ ok: true, value: undefined })
  )
  assert.equal(skippedResult.ok, false)
  assert.equal(skippedResult.error.reason, 'TRANSACTION_FAILED')

  const fabricated = createPostgresAuthStore({
    client: {
      async query() {
        return { rows: [] }
      },
      async transaction() {
        return { ok: true, value: 'fabricated' }
      }
    }
  })
  const fabricatedResult = await fabricated.transaction.run(
    { requiredScopes: ['accounts'] },
    async () => ({ ok: true, value: 'expected' })
  )
  assert.equal(fabricatedResult.ok, false)
  assert.equal(fabricatedResult.error.reason, 'TRANSACTION_FAILED')

  const substituted = createPostgresAuthStore({
    client: {
      async query() {
        return { rows: [] }
      },
      async transaction(fn) {
        await fn({ async query() { return { rows: [] } } })
        return { ok: true, value: 'substituted' }
      }
    }
  })
  const substitutedResult = await substituted.transaction.run(
    { requiredScopes: ['accounts'] },
    async () => ({ ok: true, value: 'expected' })
  )
  assert.equal(substitutedResult.ok, false)
  assert.equal(substitutedResult.error.reason, 'TRANSACTION_FAILED')

  const repeated = createPostgresAuthStore({
    client: {
      async query() {
        return { rows: [] }
      },
      async transaction(fn) {
        const transactionClient = { async query() { return { rows: [] } } }
        const first = await fn(transactionClient)
        try {
          await fn(transactionClient)
        } catch {
          return first
        }
        return first
      }
    }
  })
  const repeatedResult = await repeated.transaction.run(
    { requiredScopes: ['accounts'] },
    async () => ({ ok: true, value: 'expected' })
  )
  assert.equal(repeatedResult.ok, false)
  assert.equal(repeatedResult.error.reason, 'TRANSACTION_FAILED')

  const malformedCallback = createPostgresAuthStore({
    client: {
      async query() {
        return { rows: [] }
      },
      async transaction(fn) {
        return fn({ async query() { return { rows: [] } } })
      }
    }
  })
  const malformedResult = await malformedCallback.transaction.run(
    { requiredScopes: ['accounts'] },
    async () => undefined
  )
  assert.equal(malformedResult.ok, false)
  assert.equal(malformedResult.error.reason, 'TRANSACTION_FAILED')

  const clonedReceipt = createPostgresAuthStore({
    client: {
      async query() {
        return { rows: [] }
      },
      async transaction(fn) {
        return structuredClone(await fn({ async query() { return { rows: [] } } }))
      }
    }
  })
  const clonedReceiptResult = await clonedReceipt.transaction.run(
    { requiredScopes: ['accounts'] },
    async () => ({ ok: true, value: 'expected' })
  )
  assert.deepEqual(clonedReceiptResult, { ok: true, value: 'expected' })
})

test('transaction operations use the provider transaction client', async () => {
  const rootCalls = []
  const transactionCalls = []
  const store = createPostgresAuthStore({
    client: {
      async query(sql) {
        rootCalls.push(sql)
        return { rows: [] }
      },
      async transaction(fn) {
        return fn({
          async query(sql) {
            transactionCalls.push(sql)
            return { rows: [] }
          }
        })
      }
    }
  })

  const result = await store.transaction.run({ requiredScopes: ['accounts'] }, async (tx) => {
    return store.durable.accounts.findById({
      tenantId: 'tenant_1',
      accountId: 'account_1'
    }, tx)
  })

  assert.deepEqual(result, { ok: true, value: null })
  assert.equal(rootCalls.length, 0)
  assert.equal(transactionCalls.length, 1)
})

test('transaction scopes fail before the provider and reject undeclared store access', async () => {
  let providerCalls = 0
  let callbackCalls = 0
  const store = createPostgresAuthStore({
    client: {
      async query() {
        return { rows: [] }
      },
      async transaction(fn) {
        providerCalls += 1
        return fn({
          async query() {
            return { rows: [] }
          }
        })
      }
    }
  })

  const unsupported = await store.transaction.run({ requiredScopes: ['outbox'] }, async () => {
    callbackCalls += 1
    return { ok: true, value: undefined }
  })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error.reason, 'TRANSACTION_FAILED')
  assert.equal(providerCalls, 0)
  assert.equal(callbackCalls, 0)

  const scoped = await store.transaction.run({ requiredScopes: ['accounts'] }, async (tx) => {
    assert.deepEqual(tx.covers, ['accounts'])
    await assert.rejects(
      store.session.sessions.findById({ tenantId: 'tenant_1', sessionId: 'session_1' }, tx),
      /does not belong/
    )
    return { ok: true, value: undefined }
  })
  assert.equal(scoped.ok, true)
  assert.equal(providerCalls, 1)
})

test('transaction provider rolls back failed Results and preserves the failure', async () => {
  let rolledBack = false
  const store = createPostgresAuthStore({
    client: {
      async query() {
        return { rows: [] }
      },
      async transaction(fn) {
        try {
          return await fn({
            async query() {
              return { rows: [] }
            }
          })
        } catch (error) {
          rolledBack = true
          throw error
        }
      }
    }
  })
  const failure = {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'test',
      reason: 'EXPECTED_FAILURE'
    }
  }

  const result = await store.transaction.run({ requiredScopes: ['accounts'] }, async () => failure)

  assert.equal(rolledBack, true)
  assert.equal(result, failure)
})

test('store rejects a transaction context from another store', async () => {
  const makeClient = () => ({
    async query() {
      return { rows: [] }
    },
    async transaction(fn) {
      return fn({
        async query() {
          return { rows: [] }
        }
      })
    }
  })
  const first = createPostgresAuthStore({ client: makeClient() })
  const second = createPostgresAuthStore({ client: makeClient() })

  const result = await first.transaction.run({ requiredScopes: ['accounts'] }, async (tx) => {
    await assert.rejects(
      second.durable.accounts.findById({ tenantId: 'tenant_1', accountId: 'account_1' }, tx),
      /does not belong/
    )
    return { ok: true, value: undefined }
  })

  assert.equal(result.ok, true)
})

test('simultaneously active stores reject colliding foreign transaction ids', async () => {
  const makeClient = () => ({
    async query() {
      return { rows: [] }
    },
    async transaction(fn) {
      return fn({
        async query() {
          return { rows: [] }
        }
      })
    }
  })
  const first = createPostgresAuthStore({ client: makeClient() })
  const second = createPostgresAuthStore({ client: makeClient() })

  const result = await first.transaction.run({ requiredScopes: ['accounts'] }, async (firstTx) => second.transaction.run({ requiredScopes: ['accounts'] }, async (secondTx) => {
    assert.equal(firstTx.transactionId, 'pg_1')
    assert.equal(secondTx.transactionId, 'pg_1')
    await assert.rejects(
      second.durable.accounts.findById({ tenantId: 'tenant_1', accountId: 'account_1' }, firstTx),
      /does not belong/
    )
    await assert.rejects(
      first.durable.accounts.findById({ tenantId: 'tenant_1', accountId: 'account_1' }, secondTx),
      /does not belong/
    )
    return { ok: true, value: undefined }
  }))

  assert.equal(result.ok, true)
})

test('auth and outbox composition shares one identity-bound transaction', async () => {
  const clients = []
  const root = {
    async query() {
      return { rows: [] }
    },
    async transaction(fn) {
      const transactionClient = {
        async query() {
          return { rows: [] }
        }
      }
      clients.push(transactionClient)
      return fn(transactionClient)
    }
  }
  const stores = createPostgresAuthOutboxStores({ client: root })

  const result = await stores.auth.transaction.run({ requiredScopes: ['accounts', 'outbox'] }, async (tx) => {
    assert.equal(tx.covers.includes('outbox'), true)
    await stores.auth.durable.accounts.findById({ tenantId: 'tenant_1', accountId: 'account_1' }, tx)
    const enqueued = await stores.outbox.enqueue({ message: outboxRecord() }, tx)
    assert.equal(enqueued.ok, false)
    return { ok: true, value: undefined }
  })

  assert.equal(result.ok, true)
  assert.equal(clients.length, 1)
})

test('postgres outbox rejects nested sealed data, private context, and malformed lease input before querying', async () => {
  let queries = 0
  const stores = createPostgresAuthOutboxStores({
    client: {
      async query() {
        queries += 1
        return { rows: [] }
      }
    }
  })
  const enqueue = stores.outbox.enqueue as (input: unknown) => ReturnType<typeof stores.outbox.enqueue>
  const claimBatch = stores.outbox.claimBatch as (input: unknown) => ReturnType<typeof stores.outbox.claimBatch>
  const markDispatched = stores.outbox.markDispatched as (input: unknown) => ReturnType<typeof stores.outbox.markDispatched>
  const now = new Date('2026-01-01T00:00:00.000Z')
  const sealed = sealedValue('ciphertext')
  const message = {
    tenantId: 'tenant_outbox_validation',
    messageId: 'message_outbox_validation',
    context: { tenantId: 'tenant_outbox_validation' },
    secretPurpose: JSON.stringify([
      'authmodules.outbox.delivery',
      'tenant_outbox_validation',
      'message_outbox_validation'
    ]),
    type: 'delivery',
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp',
      data: { nested: { code: sealed } }
    },
    dispatchPolicy: 'required',
    idempotencyKey: 'postgres-validation-message',
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
    updatedAt: now
  }

  const nestedSecret = await enqueue({ message })
  const privateContext = await enqueue({
    message: {
      ...message,
      messageId: 'message_private_context',
      message: { ...message.message, data: { code: sealed } },
      context: { tenantId: message.tenantId, ip: '127.0.0.1' }
    }
  })
  const disguised = await enqueue({
    message: {
      ...message,
      messageId: 'message_disguised_secret',
      message: { ...message.message, data: { code: sealed } },
      context: {
        tenantId: message.tenantId,
        metadata: {
          verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
        }
      }
    }
  })
  const malformedClaim = await claimBatch(undefined)
  const malformedMark = await markDispatched(undefined)

  assert.equal(nestedSecret.ok, false)
  assert.equal(nestedSecret.error.reason, 'OUTBOX_ENQUEUE_FAILED')
  assert.equal(privateContext.ok, false)
  assert.equal(disguised.ok, false)
  assert.equal(malformedClaim.ok, false)
  assert.equal(malformedMark.ok, false)
  assert.equal(queries, 0)
})

test('postgres outbox bounds expiry cleanup before claiming', async () => {
  const calls = []
  const stores = createPostgresAuthOutboxStores({
    client: {
      async query(sql, params) {
        calls.push({ sql, params })
        return { rows: [], rowCount: 0 }
      }
    }
  })
  const result = await stores.outbox.claimBatch({
    workerId: 'worker_1',
    now: new Date('2026-01-01T00:00:00.000Z'),
    limit: 25,
    leaseSeconds: 30
  })

  assert.equal(result.ok, true)
  assert.equal(calls[0].sql.includes('limit $3'), true)
  assert.equal(calls[0].sql.includes('for update skip locked'), true)
  assert.equal(calls[0].params[2], 25)
  assert.equal(calls[1].sql.includes('attempts = attempts + 1'), true)
  assert.equal(calls[1].sql.includes('for update skip locked'), true)
  assert.equal(calls[2].sql.includes('gen_random_uuid()'), true)
})

test('cleanup SQL applies a bounded limit and row locking', async () => {
  const calls = []
  const store = createPostgresAuthStore({
    client: {
      async query(sql, params) {
        calls.push({ sql, params })
        return { rows: [], rowCount: 0 }
      }
    }
  })

  await store.session.sessions.cleanupExpired({
    tenantId: 'tenant_1',
    now: new Date('2026-01-01T00:00:00.000Z'),
    limit: 10
  })
  const excessive = await store.session.sessions.cleanupExpired({
    tenantId: 'tenant_1',
    now: new Date('2026-01-01T00:00:00.000Z'),
    limit: 1001
  })

  assert.equal(calls[0].sql.includes('for update skip locked'), true)
  assert.equal(calls[0].sql.includes('limit $3'), true)
  assert.equal(calls[0].params[2], 10)
  assert.equal(excessive.ok, false)
  assert.equal(calls.length, 1)
})

function protectedValue(value) {
  return {
    type: 'protected-value',
    scheme: 'test.v1',
    redacted: '[REDACTED]',
    revealForPersistence() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function sealedValue(ciphertext) {
  return {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'test-key',
    redacted: '[REDACTED]',
    revealCiphertextForPersistence() {
      return ciphertext
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function rawSecret(value) {
  return {
    reveal() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function outboxRecord() {
  const now = new Date('2026-01-01T00:00:00.000Z')
  return {
    tenantId: 'tenant_1',
    messageId: 'message_1',
    context: { tenantId: 'tenant_1' },
    secretPurpose: '["authmodules.outbox.delivery","tenant_1","message_1"]',
    type: 'delivery',
    message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
    dispatchPolicy: 'required',
    idempotencyKey: 'outbox-message-1',
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
    updatedAt: now
  }
}
