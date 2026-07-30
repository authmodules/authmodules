import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertPublicView,
  assertRedacted,
  createMemoryAuthOutboxStores,
  createMemoryAuthStore,
  createMemoryOutboxStore,
  complianceSuites,
  createSecretFactory,
  deterministicIdGenerator,
  fixedClock,
  makeRawSecret,
  makeProtectedValue,
  makeSealedSecretValue,
  runComplianceSuite,
  toAccountView
} from '../src/index.ts'

test('fixedClock and deterministicIdGenerator produce stable values', () => {
  const clock = fixedClock(new Date('2026-01-01T00:00:00.000Z'))
  assert.equal(clock.now().toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(clock.advance(1000).toISOString(), '2026-01-01T00:00:01.000Z')
  clock.set('2026-02-01T00:00:00.000Z')
  assert.equal(clock.now().toISOString(), '2026-02-01T00:00:00.000Z')

  const ids = deterministicIdGenerator('case')
  assert.equal(ids.generate({ kind: 'account' }), 'case_account_0001')
  assert.equal(ids.generate({ kind: 'account' }), 'case_account_0002')
  assert.equal(ids.generate({ kind: 'session' }), 'case_session_0001')
})

test('built-in compliance suites are executable and non-empty', async () => {
  for (const suite of Object.values(complianceSuites)) {
    assert.equal(suite.cases.length > 0, true, `${suite.name} must contain executable cases`)
    assert.equal(typeof suite.cases[0].run, 'function')
  }

  await runComplianceSuite(complianceSuites.coreFlows, {
    auth: {
      async getSession(input) {
        if (!input) {
          return {
            ok: false,
            error: {
              type: 'auth.failure',
              internalReason: 'VALIDATION_FAILED',
              publicError: { code: 'INVALID_INPUT', message: 'Authentication request failed.' }
            }
          }
        }
        return { ok: true, value: null }
      }
    }
  })
  await runComplianceSuite(complianceSuites.security, {
    secretFactory: createSecretFactory()
  })
})

test('memory outbox store reclaims expired leases and enforces idempotency', async () => {
  const store = createMemoryOutboxStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const message = {
    tenantId: 'tenant_1',
    messageId: 'message_1',
    context: { tenantId: 'tenant_1', locale: 'en' },
    secretPurpose: JSON.stringify(['authmodules.outbox.delivery', 'tenant_1', 'message_1']),
    type: 'delivery',
    message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
    dispatchPolicy: 'required',
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    idempotencyKey: 'otp:user@example.test',
    availableAt: now,
    createdAt: now,
    updatedAt: now
  }

  const first = await store.enqueue({ message })
  const duplicate = await store.enqueue({
    message: {
      ...message,
      messageId: 'message_2',
      secretPurpose: JSON.stringify(['authmodules.outbox.delivery', 'tenant_1', 'message_2']),
      message: {
        ...message.message,
        to: { ...message.message.to, target: 'attacker@example.test' }
      }
    }
  })
  const claimed = await store.claimBatch({ now, limit: 1, workerId: 'worker_1', leaseSeconds: 10 })
  const duplicateAfterClaim = await store.enqueue({
    message: {
      ...message,
      messageId: 'message_3',
      secretPurpose: JSON.stringify(['authmodules.outbox.delivery', 'tenant_1', 'message_3'])
    }
  })
  const reclaimed = await store.claimBatch({
    now: new Date(now.getTime() + 10000),
    limit: 1,
    workerId: 'worker_2',
    leaseSeconds: 10
  })

  assert.equal(first.ok, true)
  assert.equal(duplicate.value.messageId, 'message_1')
  assert.equal(duplicate.value.message.to.target, 'user@example.test')
  assert.equal(claimed.value[0].lease.workerId, 'worker_1')
  assert.equal(duplicateAfterClaim.value.messageId, 'message_1')
  assert.equal('lease' in duplicateAfterClaim.value, false)
  assert.equal(reclaimed.value[0].lease.workerId, 'worker_2')
  assert.equal(reclaimed.value[0].attempts, 1)
  assert.equal(store.__unsafeMessages.size, 1)
})

test('memory stores do not retain caller-owned update dates', async () => {
  const outbox = createMemoryOutboxStore()
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  await outbox.enqueue({ message: outboxMessage('message_dates', 'delivery-dates', createdAt) })
  const claimed = await outbox.claimBatch({
    now: createdAt,
    limit: 1,
    workerId: 'worker_1',
    leaseSeconds: 10
  })
  const failedAt = new Date('2026-01-01T00:00:01.000Z')
  const retryAt = new Date('2026-01-01T00:00:02.000Z')
  await outbox.markFailed({
    tenantId: 'tenant_1',
    messageId: 'message_dates',
    workerId: 'worker_1',
    leaseId: claimed.value[0].lease.leaseId,
    now: failedAt,
    reason: 'DELIVERY_FAILED',
    terminal: false,
    retryAt
  })
  failedAt.setUTCFullYear(2030)
  retryAt.setUTCFullYear(2030)
  const storedOutbox = outbox.__unsafeMessages.get('tenant_1\u0000message_dates')
  assert.equal(storedOutbox.updatedAt.toISOString(), '2026-01-01T00:00:01.000Z')
  assert.equal(storedOutbox.availableAt.toISOString(), '2026-01-01T00:00:02.000Z')
  assert.equal(storedOutbox.lastFailureReason, 'DELIVERY_FAILED')

  const auth = createMemoryAuthStore()
  await auth.durable.accounts.create({
    record: {
      tenantId: 'tenant_1',
      accountId: 'account_dates',
      status: 'active',
      createdAt,
      updatedAt: createdAt
    }
  })
  const updatedAt = new Date('2026-01-01T00:01:00.000Z')
  await auth.durable.accounts.updateStatus({
    tenantId: 'tenant_1',
    accountId: 'account_dates',
    status: 'disabled',
    now: updatedAt
  })
  updatedAt.setUTCFullYear(2030)
  const storedAccount = await auth.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_dates'
  })
  assert.equal(storedAccount.value.updatedAt.toISOString(), '2026-01-01T00:01:00.000Z')
})

test('memory outbox rejects malformed lease mutation timestamps and failure metadata', async () => {
  const store = createMemoryOutboxStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const message = outboxMessage('message_mutations', 'delivery-mutations', now)
  await store.enqueue({ message })
  const claimed = await store.claimBatch({
    now,
    limit: 1,
    workerId: 'worker_1',
    leaseSeconds: 10
  })
  const leaseId = claimed.value[0].lease.leaseId
  const base = {
    tenantId: message.tenantId,
    messageId: message.messageId,
    workerId: 'worker_1',
    leaseId
  }

  assert.equal((await store.markDispatched({
    ...base,
    now: '2026-01-01T00:00:01.000Z'
  })).ok, false)
  assert.equal((await store.markFailed({
    ...base,
    now: new Date(now.getTime() + 1000),
    reason: '',
    retryAt: new Date(Number.NaN)
  })).ok, false)
  assert.equal((await store.renewLease({
    ...base,
    now: new Date(Number.NaN),
    leaseSeconds: 10
  })).ok, false)

  const stored = store.__unsafeMessages.get('tenant_1\u0000message_mutations')
  assert.equal(stored.status, 'claimed')
  assert.equal(stored.updatedAt.toISOString(), now.toISOString())
})

test('memory outbox batch is atomic and terminal cleanup releases idempotency keys', async () => {
  const store = createMemoryOutboxStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const first = outboxMessage('message_first', 'delivery-first', now)
  assert.equal((await store.enqueue({ message: first })).ok, true)

  const batch = await store.enqueueBatch({
    messages: [
      outboxMessage('message_staged', 'delivery-staged', now),
      { ...first, idempotencyKey: 'delivery-conflicting-id' }
    ]
  })
  assert.equal(batch.ok, false)
  assert.equal(store.__unsafeMessages.size, 1)
  assert.equal(store.__unsafeMessages.has('tenant_1\u0000message_staged'), false)
  assert.equal(store.__unsafeIdempotencyKeys.has('tenant_1\u0000delivery-staged'), false)

  const claimed = await store.claimBatch({
    now,
    limit: 1,
    workerId: 'worker_1',
    leaseSeconds: 10
  })
  const renewedAt = new Date(now.getTime() + 1000)
  const renewed = await store.renewLease({
    tenantId: first.tenantId,
    messageId: first.messageId,
    workerId: 'worker_1',
    leaseId: claimed.value[0].lease.leaseId,
    now: renewedAt,
    leaseSeconds: 10
  })
  assert.equal(renewed.ok, true)
  assert.equal(renewed.value.leaseUntil.toISOString(), new Date(now.getTime() + 11000).toISOString())
  assert.equal((await store.renewLease({
    tenantId: first.tenantId,
    messageId: first.messageId,
    workerId: 'worker_2',
    leaseId: claimed.value[0].lease.leaseId,
    now: renewedAt,
    leaseSeconds: 10
  })).ok, false)

  const dispatchedAt = new Date(now.getTime() + 2000)
  assert.equal((await store.markDispatched({
    tenantId: first.tenantId,
    messageId: first.messageId,
    workerId: 'worker_1',
    leaseId: claimed.value[0].lease.leaseId,
    now: dispatchedAt
  })).ok, true)
  const cleaned = await store.cleanupTerminal({
    before: dispatchedAt,
    statuses: ['dispatched'],
    limit: 1,
    tenantId: first.tenantId
  })
  assert.deepEqual(cleaned, { ok: true, value: 1 })
  assert.equal(store.__unsafeMessages.size, 0)
  assert.equal(store.__unsafeIdempotencyKeys.size, 0)
  assert.equal((await store.enqueue({
    message: {
      ...first,
      messageId: 'message_reused',
      secretPurpose: JSON.stringify(['authmodules.outbox.delivery', first.tenantId, 'message_reused'])
    }
  })).ok, true)
})

test('memory outbox dead-letters an abandoned final attempt', async () => {
  const store = createMemoryOutboxStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const message = { ...outboxMessage('message_final', 'delivery-final', now), maxAttempts: 1 }
  await store.enqueue({ message })
  await store.claimBatch({ now, limit: 1, workerId: 'worker_1', leaseSeconds: 1 })
  const reclaimed = await store.claimBatch({
    now: new Date(now.getTime() + 1000),
    limit: 1,
    workerId: 'worker_2',
    leaseSeconds: 1
  })
  assert.deepEqual(reclaimed, { ok: true, value: [] })
  const stored = store.__unsafeMessages.get('tenant_1\u0000message_final')
  assert.equal(stored.status, 'dead')
  assert.equal(stored.attempts, 1)
  assert.equal(stored.lease, undefined)
})

test('memory outbox store rejects malformed enqueue records', async () => {
  const store = createMemoryOutboxStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const result = await store.enqueue({
    message: {
      tenantId: 'tenant_1',
      messageId: '',
      context: { tenantId: 'tenant_2' },
      secretPurpose: '',
      type: 'delivery',
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
      dispatchPolicy: 'required',
      status: 'claimed',
      attempts: 1,
      maxAttempts: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'OUTBOX_ENQUEUE_FAILED')
  assert.equal(store.__unsafeMessages.size, 0)
  const oversizedClaim = await store.claimBatch({
    now,
    limit: 1001,
    workerId: 'worker_1',
    leaseSeconds: 30
  })
  const oversizedLease = await store.claimBatch({
    now,
    limit: 1,
    workerId: 'worker_1',
    leaseSeconds: 86401
  })
  assert.equal(oversizedClaim.ok, false)
  assert.equal(oversizedLease.ok, false)
})

test('memory outbox store enforces shallow sealed data and narrow dispatch context', async () => {
  const store = createMemoryOutboxStore()
  const enqueue = store.enqueue as (input: unknown) => ReturnType<typeof store.enqueue>
  const now = new Date('2026-01-01T00:00:00.000Z')
  const sealedInput = {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'test-key',
    ciphertext: 'ciphertext'
  }
  const sealed = {
    type: 'sealed-secret',
    algorithm: sealedInput.algorithm,
    keyId: sealedInput.keyId,
    redacted: '[REDACTED]',
    revealCiphertextForPersistence() {
      return sealedInput.ciphertext
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
  const message = {
    tenantId: 'tenant_validation',
    messageId: 'message_validation',
    context: { tenantId: 'tenant_validation' },
    secretPurpose: JSON.stringify([
      'authmodules.outbox.delivery',
      'tenant_validation',
      'message_validation'
    ]),
    type: 'delivery',
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp',
      data: { code: sealed }
    },
    dispatchPolicy: 'required',
    idempotencyKey: 'validation-message',
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
    updatedAt: now
  }

  const valid = await enqueue({ message })
  const nestedSecret = await enqueue({
    message: {
      ...message,
      messageId: 'message_nested_secret',
      message: { ...message.message, data: { nested: { code: sealed } } }
    }
  })
  const privateContext = await enqueue({
    message: {
      ...message,
      messageId: 'message_private_context',
      context: { tenantId: message.tenantId, actor: { type: 'system', name: 'internal' } }
    }
  })
  const disguised = await enqueue({
    message: {
      ...message,
      messageId: 'message_disguised_secret',
      context: {
        tenantId: message.tenantId,
        metadata: {
          verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
        }
      }
    }
  })
  const extraSecretField = await enqueue({
    message: {
      ...message,
      messageId: 'message_extra_secret_field',
      message: {
        ...message.message,
        data: { code: { ...sealed, rawLeak: makeRawSecret('must-not-cross') } }
      }
    }
  })

  sealed.algorithm = 'mutated.v1'
  sealedInput.ciphertext = 'mutated-ciphertext'

  assert.equal(valid.ok, true)
  assert.equal(nestedSecret.ok, false)
  assert.equal(privateContext.ok, false)
  assert.equal(disguised.ok, false)
  assert.equal(extraSecretField.ok, false)
  assert.equal(
    store.__unsafeMessages.get('tenant_validation\u0000message_validation').message.data.code.algorithm,
    'test.v1'
  )
  assert.equal(store.__unsafeMessages.size, 1)
})

test('memory outbox store rejects batches above the aggregate payload budget', async () => {
  const store = createMemoryOutboxStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const blob = 'x'.repeat(999_000)
  const result = await store.enqueueBatch({
    messages: Array.from({ length: 11 }, (_, index) => ({
      ...outboxMessage(`large_${index}`, `large-${index}`, now),
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'large',
        data: { blob }
      }
    }))
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'OUTBOX_ENQUEUE_FAILED')
  assert.equal(store.__unsafeMessages.size, 0)
})

test('secret helpers redact serialized raw values', () => {
  const secret = makeRawSecret('not-public', 'value=not-public')
  const protectedSecret = makeProtectedValue({
    type: 'protected-value',
    scheme: 'test.v1',
    value: 'protected-secret'
  }, 'hash=protected-secret')
  const sealedSecret = makeSealedSecretValue({
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'test-key',
    ciphertext: 'sealed-secret'
  }, 'cipher=sealed-secret')

  assert.equal(secret.reveal(), 'not-public')
  assertRedacted(secret, 'not-public')
  assert.equal(JSON.stringify(secret), '"[REDACTED]"')
  assert.equal(protectedSecret.revealForPersistence(), 'protected-secret')
  assert.equal(sealedSecret.revealCiphertextForPersistence(), 'sealed-secret')
  assert.equal(JSON.stringify({ protectedSecret, sealedSecret }), '{"protectedSecret":"[REDACTED]","sealedSecret":"[REDACTED]"}')
})

test('secret helpers snapshot mutable inputs and dates', () => {
  const rawBytes = new Uint8Array([1, 2, 3])
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date('2026-01-01T01:00:00.000Z')
  const protectedInput = {
    type: 'protected-value',
    scheme: 'test.v1',
    value: 'protected-before',
    createdAt
  }
  const sealedInput = {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'test-key',
    ciphertext: 'sealed-before',
    expiresAt
  }
  const raw = makeRawSecret(rawBytes)
  const protectedSecret = makeProtectedValue(protectedInput)
  const sealedSecret = makeSealedSecretValue(sealedInput)

  rawBytes[0] = 9
  protectedInput.value = 'protected-after'
  sealedInput.ciphertext = 'sealed-after'
  createdAt.setUTCFullYear(2030)
  expiresAt.setUTCFullYear(2030)
  const firstRawReveal = raw.reveal()
  firstRawReveal[1] = 9

  assert.deepEqual([...raw.reveal()], [1, 2, 3])
  assert.equal(protectedSecret.revealForPersistence(), 'protected-before')
  assert.equal(sealedSecret.revealCiphertextForPersistence(), 'sealed-before')
  assert.equal(protectedSecret.createdAt.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(sealedSecret.expiresAt.toISOString(), '2026-01-01T01:00:00.000Z')
  assert.equal(Object.isFrozen(raw), true)
  assert.equal(Object.isFrozen(protectedSecret), true)
  assert.equal(Object.isFrozen(sealedSecret), true)
})

test('memory stores snapshot stateful secret wrappers exactly once', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let protectedReveals = 0
  const tokenHash = {
    type: 'protected-value',
    scheme: 'token.v1',
    redacted: '[REDACTED]',
    revealForPersistence() {
      protectedReveals += 1
      return protectedReveals === 1 ? 'stable-verifier' : 'mutated-verifier'
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
  const auth = createMemoryAuthStore()
  await auth.durable.accounts.create({
    record: {
      tenantId: 'tenant_1',
      accountId: 'account_1',
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
  })
  const session = await auth.session.sessions.create({
    record: {
      tenantId: 'tenant_1',
      sessionId: 'session_stateful_secret',
      accountId: 'account_1',
      tokenHash,
      status: 'active',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now
    }
  })
  assert.equal(session.ok, true)
  assert.equal(protectedReveals, 1)
  assert.equal(session.value.tokenHash.revealForPersistence(), 'stable-verifier')

  let sealedReveals = 0
  const sealed = {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'test-key',
    redacted: '[REDACTED]',
    revealCiphertextForPersistence() {
      sealedReveals += 1
      return sealedReveals === 1 ? 'stable-ciphertext' : 'mutated-ciphertext'
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
  const outbox = createMemoryOutboxStore()
  const message = outboxMessage('message_stateful_secret', 'delivery-stateful-secret', now)
  const enqueued = await outbox.enqueue({
    message: {
      ...message,
      message: {
        ...message.message,
        data: { code: sealed }
      }
    }
  })
  assert.equal(enqueued.ok, true)
  assert.equal(sealedReveals, 1)
  assert.equal(
    enqueued.value.message.data.code.revealCiphertextForPersistence(),
    'stable-ciphertext'
  )
})

test('public-view assertions inspect structure without rejecting safe text', () => {
  assert.doesNotThrow(() => assertPublicView({ description: 'material is documented here' }))
  assert.throws(
    () => assertPublicView({ leaked: makeRawSecret('must-not-cross') }),
    /secret-bearing/
  )
})

test('memory auth store creates clone-safe account records', async () => {
  const store = createMemoryAuthStore()
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const record = {
    tenantId: 'tenant_1',
    accountId: 'account_1',
    status: 'active',
    publicData: { email: 'user@example.test' },
    createdAt,
    updatedAt: createdAt
  }

  const created = await store.durable.accounts.create({ record })
  const disguised = await store.durable.accounts.create({
    record: {
      ...record,
      accountId: 'account_secret',
      publicData: {
        verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
      }
    }
  })
  record.status = 'disabled'

  const found = await store.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_1'
  })

  assert.equal(created.ok, true)
  assert.equal(disguised.ok, false)
  assert.equal(found.ok, true)
  assert.equal(found.value.status, 'active')
  assert.deepEqual(toAccountView(found.value), {
    tenantId: 'tenant_1',
    accountId: 'account_1',
    status: 'active',
    publicData: { email: 'user@example.test' }
  })
  assert.doesNotThrow(() => assertPublicView(toAccountView(found.value)))
})

test('memory auth store isolates concurrent transaction rollback', async () => {
  const store = createMemoryAuthStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  let releaseFirst = (): void => {}
  let markFirstStarted = (): void => {}
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve
  })
  const record = (accountId: string) => ({
    tenantId: 'tenant_1',
    accountId,
    status: 'active',
    createdAt: now,
    updatedAt: now
  })

  const first = store.transaction.run({ requiredScopes: ['accounts'] }, async (tx) => {
    markFirstStarted()
    await firstGate
    await store.durable.accounts.create({ record: record('account_rolled_back') }, tx)
    return {
      ok: false,
      error: { type: 'auth.failure', internalReason: 'INTERNAL', publicError: { code: 'INTERNAL' } }
    }
  })
  await firstStarted
  const second = store.transaction.run({ requiredScopes: ['accounts'] }, async (tx) => {
    const created = await store.durable.accounts.create({ record: record('account_committed') }, tx)
    return created.ok ? { ok: true, value: undefined } : created
  })

  releaseFirst()
  await Promise.all([first, second])

  const rolledBack = await store.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_rolled_back'
  })
  const committed = await store.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_committed'
  })
  assert.equal(rolledBack.value, null)
  assert.equal(committed.value.accountId, 'account_committed')
})

test('memory transaction rollback preserves concurrent non-transaction writes', async () => {
  const store = createMemoryAuthStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  let release = (): void => {}
  let started = (): void => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  const record = (accountId: string) => ({
    tenantId: 'tenant_1',
    accountId,
    status: 'active',
    createdAt: now,
    updatedAt: now
  })

  const transaction = store.transaction.run({ requiredScopes: ['accounts'] }, async (tx) => {
    await store.durable.accounts.create({ record: record('transaction_account') }, tx)
    started()
    await gate
    return {
      ok: false,
      error: { type: 'auth.failure', internalReason: 'INTERNAL', publicError: { code: 'INTERNAL' } }
    }
  })
  await entered
  const outside = await store.durable.accounts.create({ record: record('outside_account') })
  release()
  await transaction

  const rolledBack = await store.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'transaction_account'
  })
  const preserved = await store.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'outside_account'
  })
  assert.equal(outside.ok, true)
  assert.equal(rolledBack.value, null)
  assert.equal(preserved.value.accountId, 'outside_account')
})

test('memory transactions reject unsupported and out-of-scope store access', async () => {
  const store = createMemoryAuthStore()
  let unsupportedCallbackCalled = false
  const unsupported = await store.transaction.run(
    { requiredScopes: ['outbox'] },
    async () => {
      unsupportedCallbackCalled = true
      return { ok: true, value: undefined }
    }
  )
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error.reason, 'TRANSACTION_FAILED')
  assert.equal(unsupportedCallbackCalled, false)

  let captured
  const scoped = await store.transaction.run({ requiredScopes: ['accounts'] }, async (tx) => {
    captured = tx
    assert.deepEqual(tx.covers, ['accounts'])
    const session = await store.session.sessions.findById({
      tenantId: 'tenant_1',
      sessionId: 'session_1'
    }, tx)
    assert.equal(session.ok, false)
    return { ok: true, value: undefined }
  })
  assert.equal(scoped.ok, true)

  const expiredContext = await store.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_1'
  }, captured)
  assert.equal(expiredContext.ok, false)
})

test('memory auth and outbox stores commit and roll back one shared transaction', async () => {
  const stores = createMemoryAuthOutboxStores()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const account = {
    tenantId: 'tenant_1',
    accountId: 'account_atomic',
    status: 'active' as const,
    createdAt: now,
    updatedAt: now
  }
  const message = outboxMessage('message_atomic', 'delivery-atomic', now)

  const rolledBack = await stores.auth.transaction.run(
    { requiredScopes: ['accounts', 'outbox'] },
    async (tx) => {
      assert.equal((await stores.auth.durable.accounts.create({ record: account }, tx)).ok, true)
      assert.equal((await stores.outbox.enqueue({ message }, tx)).ok, true)
      return {
        ok: false,
        error: { type: 'component.failure', component: 'test', reason: 'EXPECTED_ROLLBACK' }
      }
    }
  )
  assert.equal(rolledBack.ok, false)
  assert.equal((await stores.auth.durable.accounts.findById({
    tenantId: account.tenantId,
    accountId: account.accountId
  })).value, null)
  assert.equal(stores.outbox.__unsafeMessages.size, 0)

  const committed = await stores.auth.transaction.run(
    { requiredScopes: ['accounts', 'outbox'] },
    async (tx) => {
      const created = await stores.auth.durable.accounts.create({ record: account }, tx)
      if (!created.ok) return created
      const enqueued = await stores.outbox.enqueue({ message }, tx)
      return enqueued.ok ? { ok: true, value: undefined } : enqueued
    }
  )
  assert.equal(committed.ok, true)
  assert.equal((await stores.auth.durable.accounts.findById({
    tenantId: account.tenantId,
    accountId: account.accountId
  })).value.accountId, account.accountId)
  assert.equal(stores.outbox.__unsafeMessages.size, 1)
})

test('memory shared transactions conflict with concurrent outbox cleanup reads', async () => {
  const stores = createMemoryAuthOutboxStores()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const existing = outboxMessage('message_existing', 'delivery-existing', now)
  await stores.outbox.enqueue({ message: existing })
  const claimed = await stores.outbox.claimBatch({
    now,
    limit: 1,
    workerId: 'worker_1',
    leaseSeconds: 30
  })
  await stores.outbox.markDispatched({
    tenantId: existing.tenantId,
    messageId: existing.messageId,
    workerId: 'worker_1',
    leaseId: claimed.value[0].lease.leaseId,
    now: new Date(now.getTime() + 1)
  })

  let release = (): void => {}
  let entered = (): void => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const transaction = stores.auth.transaction.run(
    { requiredScopes: ['accounts', 'outbox'] },
    async (tx) => {
      const account = await stores.auth.durable.accounts.create({
        record: {
          tenantId: 'tenant_1',
          accountId: 'account_read_conflict',
          status: 'active',
          createdAt: now,
          updatedAt: now
        }
      }, tx)
      if (!account.ok) return account
      const repeated = await stores.outbox.enqueue({
        message: outboxMessage('message_repeated', 'delivery-existing', now)
      }, tx)
      entered()
      await gate
      return repeated.ok ? { ok: true, value: undefined } : repeated
    }
  )

  await started
  const cleaned = await stores.outbox.cleanupTerminal({
    before: new Date(now.getTime() + 1),
    limit: 1,
    statuses: ['dispatched']
  })
  release()
  const result = await transaction

  assert.equal(cleaned.ok, true)
  assert.equal(cleaned.value, 1)
  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'TRANSACTION_FAILED')
  assert.equal((await stores.auth.durable.accounts.findById({
    tenantId: 'tenant_1',
    accountId: 'account_read_conflict'
  })).value, null)
})

test('memory auth store rejects raw secret persistence and duplicate credentials', async () => {
  const store = createMemoryAuthStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const base = {
    tenantId: 'tenant_1',
    accountId: 'account_1',
    identityId: 'identity_1',
    methodId: 'password',
    methodKind: 'password',
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now
  }
  await store.durable.accounts.create({
    record: {
      tenantId: base.tenantId,
      accountId: base.accountId,
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
  })
  await store.durable.identities.create({
    record: {
      tenantId: base.tenantId,
      identityId: base.identityId,
      accountId: base.accountId,
      methodId: base.methodId,
      methodKind: base.methodKind,
      subject: 'user@example.test',
      subjectKind: 'email',
      createdAt: now,
      updatedAt: now
    }
  })

  const raw = await store.durable.credentials.create({
    record: { ...base, credentialId: 'credential_raw', material: makeRawSecret('plain-text') }
  })
  const nested = await store.durable.credentials.create({
    record: {
      ...base,
      credentialId: 'credential_nested',
      material: {
        schemaVersion: 'password.v1',
        privateData: {
          nested: {
            passwordHash: makeProtectedValue({ scheme: 'test-v1', value: 'protected', createdAt: now })
          }
        }
      }
    }
  })
  const extraSecretField = await store.durable.credentials.create({
    record: {
      ...base,
      credentialId: 'credential_extra_secret_field',
      material: {
        schemaVersion: 'password.v1',
        privateData: {
          passwordHash: {
            ...makeProtectedValue({ scheme: 'test-v1', value: 'protected', createdAt: now }),
            rawLeak: makeRawSecret('must-not-cross')
          }
        }
      }
    }
  })
  assert.equal(raw.ok, false)
  assert.equal(nested.ok, false)
  assert.equal(extraSecretField.ok, false)

  const material = {
    schemaVersion: 'password.v1',
    privateData: {
      passwordHash: makeProtectedValue({ scheme: 'test-v1', value: 'protected', createdAt: now })
    }
  }
  const first = await store.durable.credentials.create({
    record: { ...base, credentialId: 'credential_1', material }
  })
  const duplicate = await store.durable.credentials.create({
    record: { ...base, credentialId: 'credential_2', material }
  })
  assert.equal(first.ok, true)
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error.reason, 'CREDENTIAL_CONFLICT')
  assert.equal(store.__unsafeState.credentials.size, 1)
})

test('memory auth store rejects orphan identity, credential, and session records', async () => {
  const store = createMemoryAuthStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const identity = await store.durable.identities.create({
    record: {
      tenantId: 'tenant_1',
      identityId: 'identity_orphan',
      accountId: 'account_missing',
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
      credentialId: 'credential_orphan',
      accountId: 'account_missing',
      identityId: 'identity_missing',
      methodId: 'password.email',
      methodKind: 'password',
      status: 'active',
      material: { schemaVersion: 'password.v1' },
      version: 1,
      createdAt: now,
      updatedAt: now
    }
  })
  const session = await store.session.sessions.create({
    record: {
      tenantId: 'tenant_1',
      sessionId: 'session_orphan',
      accountId: 'account_missing',
      tokenHash: makeProtectedValue({ scheme: 'token.v1', value: 'hash' }),
      status: 'active',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now
    }
  })

  assert.equal(identity.ok, false)
  assert.equal(credential.ok, false)
  assert.equal(session.ok, false)
})

test('memory auth store rejects private challenge binding fields', async () => {
  const store = createMemoryAuthStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const result = await store.ephemeral.challenges.create({
    record: {
      tenantId: 'tenant_1',
      challengeId: 'challenge_private',
      methodId: 'otp.email',
      methodKind: 'otp',
      status: 'pending',
      material: { schemaVersion: 'otp.v1' },
      binding: {
        account: { mode: 'create-new-account' },
        policyInput: { ip: '192.0.2.1' }
      },
      attempts: 0,
      maxAttempts: 3,
      version: 1,
      expiresAt: new Date(now.getTime() + 300000),
      createdAt: now,
      updatedAt: now
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'STORE_UNAVAILABLE')
})

test('memory auth store bounds cleanup batches and rejects invalid challenge session TTLs', async () => {
  const store = createMemoryAuthStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  for (const ttlSeconds of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await store.ephemeral.challenges.create({
      record: {
        tenantId: 'tenant_1',
        challengeId: `challenge_ttl_${ttlSeconds}`,
        methodId: 'otp.email',
        methodKind: 'otp',
        status: 'pending',
        material: { schemaVersion: 'otp.v1' },
        binding: {
          account: { mode: 'create-new-account' },
          session: { ttlSeconds }
        },
        attempts: 0,
        maxAttempts: 3,
        version: 1,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now
      }
    })
    assert.equal(result.ok, false)
  }

  const sessionCleanup = await store.session.sessions.cleanupExpired({
    tenantId: 'tenant_1',
    now,
    limit: 1001
  })
  const challengeCleanup = await store.ephemeral.challenges.cleanupExpired({
    tenantId: 'tenant_1',
    now,
    limit: 1001
  })

  assert.equal(sessionCleanup.ok, false)
  assert.equal(challengeCleanup.ok, false)
})

test('memory auth store enforces PostgreSQL session and challenge invariants', async () => {
  const store = createMemoryAuthStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  await store.durable.accounts.create({
    record: {
      tenantId: 'tenant_1',
      accountId: 'account_1',
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
  })
  const sessionBase = {
    tenantId: 'tenant_1',
    accountId: 'account_1',
    tokenHash: makeProtectedValue({ scheme: 'token.v1', value: 'hash' }),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now
  }
  const invalidSessionExpiry = await store.session.sessions.create({
    record: {
      ...sessionBase,
      sessionId: 'session_invalid_expiry',
      status: 'active',
      expiresAt: now
    }
  })
  const invalidRevokedSession = await store.session.sessions.create({
    record: {
      ...sessionBase,
      sessionId: 'session_missing_revoked_at',
      status: 'revoked'
    }
  })
  const challengeBase = {
    tenantId: 'tenant_1',
    methodId: 'otp',
    methodKind: 'otp',
    material: { schemaVersion: 'otp.v1' },
    binding: { account: { mode: 'create-new-account' } },
    attempts: 0,
    maxAttempts: 3,
    version: 1,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now
  }
  const invalidPendingChallenge = await store.ephemeral.challenges.create({
    record: {
      ...challengeBase,
      challengeId: 'challenge_pending_with_consumed_at',
      status: 'pending',
      consumedAt: now
    }
  })
  const invalidConsumedChallenge = await store.ephemeral.challenges.create({
    record: {
      ...challengeBase,
      challengeId: 'challenge_missing_consumed_at',
      status: 'consumed'
    }
  })

  for (const result of [
    invalidSessionExpiry,
    invalidRevokedSession,
    invalidPendingChallenge,
    invalidConsumedChallenge
  ]) {
    assert.equal(result.ok, false)
    assert.equal(result.error.reason, 'STORE_UNAVAILABLE')
  }
})

test('memory auth store preserves terminal session and challenge states', async () => {
  const store = createMemoryAuthStore()
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const expiredAt = new Date('2026-01-01T00:01:00.000Z')
  const tokenHash = makeProtectedValue({ scheme: 'test-v1', value: 'hash', createdAt })
  await store.durable.accounts.create({
    record: {
      tenantId: 'tenant_1',
      accountId: 'account_1',
      status: 'active',
      createdAt,
      updatedAt: createdAt
    }
  })
  await store.session.sessions.create({
    record: {
      tenantId: 'tenant_1',
      sessionId: 'session_1',
      accountId: 'account_1',
      tokenHash,
      status: 'active',
      issuedAt: createdAt,
      expiresAt: expiredAt,
      createdAt,
      updatedAt: createdAt
    }
  })
  await store.session.sessions.cleanupExpired({ tenantId: 'tenant_1', now: expiredAt, limit: 1 })
  const revoked = await store.session.sessions.revoke({ tenantId: 'tenant_1', sessionId: 'session_1', now: expiredAt })
  assert.equal(revoked.value.status, 'expired')

  const material = {
    schemaVersion: 'otp.v1',
    privateData: {
      verifier: makeProtectedValue({ scheme: 'otp-v1', value: 'challenge', createdAt })
    }
  }
  await store.ephemeral.challenges.create({
    record: {
      tenantId: 'tenant_1',
      challengeId: 'challenge_1',
      methodId: 'otp',
      methodKind: 'otp',
      status: 'pending',
      material,
      binding: { account: { mode: 'create-new-account' } },
      attempts: 0,
      maxAttempts: 1,
      version: 1,
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      createdAt,
      updatedAt: createdAt
    }
  })
  const failed = await store.ephemeral.challenges.recordFailedAttempt({
    tenantId: 'tenant_1',
    challengeId: 'challenge_1',
    expectedVersion: 1,
    now: expiredAt,
    reason: 'OTP_MISMATCH'
  })
  const consumed = await store.ephemeral.challenges.consumePending({
    tenantId: 'tenant_1',
    challengeId: 'challenge_1',
    expectedVersion: failed.value.challenge.version,
    now: expiredAt
  })
  assert.equal(failed.value.status, 'attempts-exceeded')
  assert.equal(consumed.value, 'attempts-exceeded')
})

test('memory auth store keys token hashes by stable verifier identity', async () => {
  const store = createMemoryAuthStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const later = new Date('2026-01-01T00:01:00.000Z')
  const tokenHash = makeProtectedValue({
    scheme: 'token.v1',
    keyId: 'primary',
    value: 'same-verifier',
    createdAt: now
  })
  await store.durable.accounts.create({
    record: {
      tenantId: 'tenant_1',
      accountId: 'account_1',
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
  })
  const created = await store.session.sessions.create({
    record: {
      tenantId: 'tenant_1',
      sessionId: 'session_hash_identity',
      accountId: 'account_1',
      tokenHash,
      status: 'active',
      issuedAt: now,
      expiresAt: later,
      createdAt: now,
      updatedAt: now
    }
  })

  const sameVerifier = await store.session.sessions.findByTokenHash({
    tenantId: 'tenant_1',
    tokenHash: makeProtectedValue({
      scheme: 'token.v1',
      keyId: 'primary',
      value: 'same-verifier',
      createdAt: later
    })
  })
  const otherScheme = await store.session.sessions.findByTokenHash({
    tenantId: 'tenant_1',
    tokenHash: makeProtectedValue({ scheme: 'token.v2', keyId: 'primary', value: 'same-verifier' })
  })
  const otherKey = await store.session.sessions.findByTokenHash({
    tenantId: 'tenant_1',
    tokenHash: makeProtectedValue({ scheme: 'token.v1', keyId: 'secondary', value: 'same-verifier' })
  })
  const duplicateVerifier = await store.session.sessions.create({
    record: {
      ...created.value,
      sessionId: 'session_duplicate_verifier',
      tokenHash: makeProtectedValue({
        scheme: 'token.v1',
        keyId: 'primary',
        value: 'same-verifier',
        createdAt: later
      })
    }
  })

  assert.equal(created.ok, true)
  assert.equal(sameVerifier.value.sessionId, 'session_hash_identity')
  assert.equal(otherScheme.value, null)
  assert.equal(otherKey.value, null)
  assert.equal(duplicateVerifier.ok, false)
})

function outboxMessage(messageId: string, idempotencyKey: string, now: Date) {
  return {
    tenantId: 'tenant_1',
    messageId,
    context: { tenantId: 'tenant_1' },
    secretPurpose: JSON.stringify(['authmodules.outbox.delivery', 'tenant_1', messageId]),
    type: 'delivery' as const,
    message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
    dispatchPolicy: 'required' as const,
    idempotencyKey,
    status: 'pending' as const,
    attempts: 0,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
    updatedAt: now
  }
}
