import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createOutboxEffectsDispatcher,
  toPersistableDeliveryMessage
} from '../src/index.ts'

test('rejects raw or protected secrets in persistable delivery messages', () => {
  const raw = toPersistableDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: {
      code: rawSecret('123456')
    }
  })
  const protectedResult = toPersistableDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: {
      hash: protectedValue('hash')
    }
  })
  const disguised = toPersistableDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: {
      hash: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
    }
  })

  assert.equal(raw.ok, false)
  assert.equal(protectedResult.ok, false)
  assert.equal(disguised.ok, false)
})

test('keeps sealed secret values persistable for deferred delivery', () => {
  const sealed = sealedValue('ciphertext')
  const result = toPersistableDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: {
      sealed
    }
  })

  assert.equal(result.ok, true)
  assert.notEqual(result.value.data.sealed, sealed)
  assert.equal(result.value.data.sealed.revealCiphertextForPersistence(), 'ciphertext')
})

test('persistable delivery messages own one stable sealed-secret snapshot', () => {
  let ciphertext = 'ciphertext:first'
  let reveals = 0
  const sealed = sealedValue('unused')
  sealed.revealCiphertextForPersistence = () => {
    reveals += 1
    return ciphertext
  }
  const message = {
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    metadata: { flow: { step: 1 } },
    data: { sealed }
  }
  const result = toPersistableDeliveryMessage(message)

  ciphertext = 'ciphertext:mutated'
  message.to.target = 'attacker@example.test'
  message.metadata.flow.step = 2

  assert.equal(result.ok, true)
  assert.equal(reveals, 1)
  assert.equal(result.value.to.target, 'user@example.test')
  assert.deepEqual(result.value.metadata, { flow: { step: 1 } })
  assert.equal(
    result.value.data.sealed.revealCiphertextForPersistence(),
    'ciphertext:first'
  )
})

test('persistable delivery snapshots read stateful address and sealed fields once', () => {
  let targetReads = 0
  let algorithmReads = 0
  class StatefulDate extends Date {
    reads = 0

    override getTime(): number {
      this.reads += 1
      return this.reads === 1
        ? Date.prototype.getTime.call(this)
        : Number.NaN
    }
  }
  const expiresAt = new StatefulDate('2026-01-01T00:05:00.000Z')
  const address = Object.defineProperty({
    channel: 'email'
  }, 'target', {
    enumerable: true,
    get() {
      targetReads += 1
      return targetReads === 1 ? 'user@example.test' : 'attacker@example.test'
    }
  })
  const sealed = Object.defineProperties({
    type: 'sealed-secret',
    redacted: '[REDACTED]',
    keyId: 'key_1',
    expiresAt,
    revealCiphertextForPersistence() {
      return 'ciphertext'
    },
    toJSON() {
      return '[REDACTED]'
    }
  }, {
    algorithm: {
      enumerable: true,
      get() {
        algorithmReads += 1
        return algorithmReads === 1 ? 'test.v1' : ''
      }
    }
  })

  const result = toPersistableDeliveryMessage({
    to: address,
    templateId: 'otp',
    data: { sealed }
  })

  assert.equal(result.ok, true)
  assert.equal(targetReads, 1)
  assert.equal(algorithmReads, 1)
  assert.equal(result.value.to.target, 'user@example.test')
  assert.equal(result.value.data.sealed.algorithm, 'test.v1')
  assert.equal(result.value.data.sealed.expiresAt.toISOString(), '2026-01-01T00:05:00.000Z')
  assert.equal(expiresAt.reads, 0)
})

test('rejects aggregate persisted secret data above the shared budget', () => {
  const result = toPersistableDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: {
      first: sealedValue('x'.repeat(600_000)),
      second: sealedValue('x'.repeat(600_000))
    }
  })

  assert.equal(result.ok, false)
})

test('rejects cyclic and oversized delivery data before persistence', async () => {
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(toPersistableDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: cyclic
  }).ok, false)

  const store = memoryOutboxStore()
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer: fakeSealer(),
    idGenerator: () => 'message_1'
  })
  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'cyclic-message',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: cyclic
      }
    }]
  })
  assert.equal(result.ok, false)
  assert.equal(store.__unsafeMessages.size, 0)
})

test('dispatcher enqueues delivery effects for outbox processing', async () => {
  const store = memoryOutboxStore()
  const metadata = { flow: { step: 1 }, labels: ['otp'] }
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer: fakeSealer(),
    idGenerator: () => 'message_1',
    maxAttempts: 3
  })
  const now = new Date('2026-01-01T00:00:00.000Z')

  const result = await dispatcher.dispatch({
    context: {
      tenantId: 'tenant_1',
      actor: { type: 'account', accountId: 'must-not-persist' },
      ip: '127.0.0.1',
      policyInput: { role: 'must-not-persist' },
      metadata
    },
    now,
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'otp:user@example.test',
        message: {
          to: { channel: 'email', target: 'user@example.test' },
          templateId: 'otp',
          data: {
            code: rawSecret('123456')
          }
        }
      }
    ]
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.deferred, [{ index: 0, type: 'delivery' }])
  assert.equal(store.__unsafeMessages.size, 1)
  assert.equal([...store.__unsafeMessages.values()][0].messageId, 'message_1')
  assert.equal([...store.__unsafeMessages.values()][0].maxAttempts, 3)
  metadata.flow.step = 2
  metadata.labels.push('mutated')
  assert.deepEqual([...store.__unsafeMessages.values()][0].context, {
    tenantId: 'tenant_1',
    metadata: { flow: { step: 1 }, labels: ['otp'] }
  })
  assert.equal(
    [...store.__unsafeMessages.values()][0].message.data.code.revealCiphertextForPersistence(),
    'sealed:123456'
  )
})

test('dispatcher keeps secret payload and recipient outside the id generator boundary', async () => {
  const store = memoryOutboxStore()
  const now = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date('2026-01-02T00:00:00.000Z')
  let generatorInput
  let reveals = 0
  const secret = {
    type: 'raw-secret',
    redacted: '[REDACTED]',
    reveal() {
      reveals += 1
      return '123456'
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer: fakeSealer(),
    now: () => new Date(now.getTime()),
    idGenerator(input) {
      generatorInput = input
      input.now.setUTCFullYear(2030)
      return 'message_1'
    }
  })

  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'immutable-effect',
      expiresAt,
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: { code: secret }
      }
    }]
  })

  assert.equal(result.ok, true)
  assert.equal(reveals, 1)
  assert.deepEqual(generatorInput.effect, {
    type: 'delivery',
    dispatchPolicy: 'required',
    idempotencyKey: 'immutable-effect'
  })
  assert.equal('message' in generatorInput.effect, false)
  assert.doesNotMatch(JSON.stringify(generatorInput), /123456|user@example/)
  const stored = [...store.__unsafeMessages.values()][0]
  assert.equal(stored.dispatchPolicy, 'required')
  assert.equal(stored.message.to.target, 'user@example.test')
  assert.equal(stored.message.templateId, 'otp')
  assert.equal(stored.availableAt.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(stored.expiresAt.toISOString(), '2026-01-02T00:00:00.000Z')
  assert.equal(now.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(expiresAt.toISOString(), '2026-01-02T00:00:00.000Z')
})

test('dispatcher reads a stateful effects property exactly once before validation', async () => {
  const store = memoryOutboxStore()
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer: fakeSealer(),
    idGenerator: () => 'message_stateful_effects'
  })
  let effectsReads = 0
  const validEffects = [{
    type: 'delivery' as const,
    dispatchPolicy: 'required' as const,
    idempotencyKey: 'stateful-effects',
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp'
    }
  }]
  const input = Object.defineProperty({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z')
  }, 'effects', {
    enumerable: true,
    get() {
      effectsReads += 1
      return effectsReads === 1 ? validEffects : []
    }
  }) as unknown as Parameters<typeof dispatcher.dispatch>[0]

  const result = await dispatcher.dispatch(input)

  assert.equal(result.ok, true)
  assert.equal(effectsReads, 1)
  assert.equal(store.__unsafeMessages.size, 1)
})

test('dispatcher rejects expired effects before enqueue', async () => {
  const store = memoryOutboxStore()
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer: fakeSealer(),
    idGenerator: () => 'message_1'
  })
  const now = new Date('2026-01-01T00:00:00.000Z')

  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'expired-message',
      expiresAt: now,
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })

  assert.equal(result.ok, false)
  assert.equal(store.__unsafeMessages.size, 0)
})

test('dispatcher rechecks expiry after sealing and immediately before enqueue', async () => {
  const initial = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date('2026-01-01T00:00:01.000Z')
  let enqueueCalls = 0
  const store = {
    async enqueueBatch(input) {
      enqueueCalls += 1
      return { ok: true, value: input.messages }
    }
  }
  const expiredAfterSeal = createOutboxEffectsDispatcher({
    store,
    sealer: fakeSealer(),
    idGenerator: () => 'message_after_seal',
    now: () => expiresAt
  })
  const afterSeal = await expiredAfterSeal.dispatch({
    context: { tenantId: 'tenant_1' },
    now: initial,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'expires-after-seal',
      expiresAt,
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })

  assert.equal(afterSeal.ok, false)
  assert.equal(enqueueCalls, 0)

  const times = [initial, expiresAt]
  const expiredBeforeEnqueue = createOutboxEffectsDispatcher({
    store,
    sealer: fakeSealer(),
    idGenerator: () => 'message_before_enqueue',
    now: () => times.shift()
  })
  const beforeEnqueue = await expiredBeforeEnqueue.dispatch({
    context: { tenantId: 'tenant_1' },
    now: initial,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'best-effort',
      expiresAt,
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })

  assert.equal(beforeEnqueue.ok, true)
  assert.equal(enqueueCalls, 0)
  assert.deepEqual(beforeEnqueue.value.failed, [{
    index: 0,
    type: 'delivery',
    reason: 'SIDE_EFFECT_FAILED'
  }])
})

test('dispatcher validates the complete batch before enqueueing', async () => {
  const store = memoryOutboxStore()
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer: fakeSealer(),
    idGenerator: ({ index }) => `message_${index}`
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'batch-first',
        message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
      },
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'batch-second',
        expiresAt: now,
        message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'expired' }
      }
    ]
  })

  assert.equal(result.ok, false)
  assert.equal(store.__unsafeMessages.size, 0)
})

test('dispatcher persists a valid effect batch with one atomic store call', async () => {
  const batches = []
  const dispatcher = createOutboxEffectsDispatcher({
    store: {
      async enqueueBatch(input) {
        batches.push(input.messages)
        return { ok: true, value: input.messages }
      }
    },
    sealer: fakeSealer(),
    idGenerator: ({ index }) => `atomic_${index}`
  })
  assert.deepEqual(dispatcher.transactionScopes, ['outbox'])

  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'atomic-first',
        message: { to: { channel: 'email', target: 'first@example.test' }, templateId: 'otp' }
      },
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'atomic-second',
        message: { to: { channel: 'email', target: 'second@example.test' }, templateId: 'otp' }
      }
    ]
  })

  assert.equal(result.ok, true)
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0].map((message) => message.messageId), ['atomic_0', 'atomic_1'])
  assert.deepEqual(result.value.deferred, [
    { index: 0, type: 'delivery' },
    { index: 1, type: 'delivery' }
  ])
})

test('best-effort enqueue failure does not discard an already accepted required batch', async () => {
  const batches = []
  const dispatcher = createOutboxEffectsDispatcher({
    store: {
      async enqueueBatch(input) {
        batches.push(input.messages)
        return batches.length === 1
          ? { ok: true, value: input.messages }
          : {
              ok: false,
              error: {
                type: 'component.failure',
                component: 'store',
                reason: 'OUTBOX_ENQUEUE_FAILED'
              }
            }
      }
    },
    sealer: fakeSealer(),
    idGenerator: ({ index }) => `mixed_${index}`
  })
  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'mixed-required',
        message: { to: { channel: 'email', target: 'required@example.test' }, templateId: 'otp' }
      },
      {
        type: 'delivery',
        dispatchPolicy: 'best-effort',
        message: { to: { channel: 'email', target: 'optional@example.test' }, templateId: 'audit' }
      }
    ]
  })

  assert.equal(result.ok, true)
  assert.deepEqual(batches.map((batch) => batch.map((message) => message.dispatchPolicy)), [
    ['required'],
    ['best-effort']
  ])
  assert.deepEqual(result.value.deferred, [{ index: 0, type: 'delivery' }])
  assert.deepEqual(result.value.failed, [{
    index: 1,
    type: 'delivery',
    reason: 'OUTBOX_ENQUEUE_FAILED'
  }])
})

test('dispatcher requires an outbox-covered transaction context', async () => {
  const dispatcher = createOutboxEffectsDispatcher({
    store: memoryOutboxStore(),
    sealer: fakeSealer(),
    idGenerator: () => 'message_1'
  })
  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    tx: { transactionId: 'tx_1', covers: ['accounts', 'challenges'] },
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'transaction-scope',
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'SIDE_EFFECT_FAILED')
})

test('dispatcher maps malformed input and thrown collaborators to effects failures', async () => {
  assert.throws(() => createOutboxEffectsDispatcher(), /options/)
  const dispatcher = createOutboxEffectsDispatcher({
    store: {
      async enqueueBatch() {
        throw new Error('database down')
      }
    },
    sealer: fakeSealer(),
    idGenerator() {
      throw new Error('id generation failed')
    }
  })

  const malformed = await dispatcher.dispatch({ effects: [] })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error.reason, 'SIDE_EFFECT_FAILED')

  const required = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'thrown-id-generator',
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })
  assert.equal(required.ok, false)
  assert.equal(required.error.reason, 'SIDE_EFFECT_FAILED')

  const bestEffort = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [{ type: 'unsupported', dispatchPolicy: 'best-effort' }]
  })
  assert.deepEqual(bestEffort, {
    ok: true,
    value: {
      dispatched: [],
      deferred: [],
      failed: [{ index: 0, type: 'delivery', reason: 'SIDE_EFFECT_FAILED' }]
    }
  })

  const throwingPolicy = {}
  Object.defineProperty(throwingPolicy, 'dispatchPolicy', {
    enumerable: true,
    get() {
      throw new Error('must not escape')
    }
  })
  const malformedPolicy = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [throwingPolicy]
  })
  assert.equal(malformedPolicy.ok, false)
  assert.equal(malformedPolicy.error.reason, 'SIDE_EFFECT_FAILED')
})

test('dispatcher rejects malformed sealer success and maps thrown enqueue', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const malformedSealer = createOutboxEffectsDispatcher({
    store: memoryOutboxStore(),
    sealer: {
      async seal() { return { ok: true, value: {} } },
      async unseal() { throw new Error('must not be called') }
    },
    idGenerator: () => 'message_1'
  })
  const invalidSeal = await malformedSealer.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'malformed-sealer',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: { code: rawSecret('123456') }
      }
    }]
  })
  assert.equal(invalidSeal.ok, false)

  const thrownStore = createOutboxEffectsDispatcher({
    store: { async enqueueBatch() { throw new Error('database down') } },
    sealer: fakeSealer(),
    idGenerator: () => 'message_1'
  })
  const enqueueFailure = await thrownStore.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'thrown-store',
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })
  assert.equal(enqueueFailure.ok, false)
  assert.equal(enqueueFailure.error.reason, 'STORE_UNAVAILABLE')
})

test('dispatcher rejects substituted store success rows', async () => {
  const dispatcher = createOutboxEffectsDispatcher({
    store: {
      async enqueueBatch(input) {
        return {
          ok: true,
          value: [{ ...input.messages[0], messageId: 'substituted' }]
        }
      }
    },
    sealer: fakeSealer(),
    idGenerator: () => 'message_1'
  })

  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'substituted-store-row',
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'STORE_UNAVAILABLE')
})

test('dispatcher validates idempotent replay payload and terminal state', async () => {
  const store = memoryOutboxStore()
  let generatedIds = 0
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer: purposeBoundSealer(),
    idGenerator: () => `replay_${++generatedIds}`
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const effect = (target = 'user@example.test', code = '123456') => ({
    type: 'delivery',
    dispatchPolicy: 'required',
    idempotencyKey: 'stable-logical-delivery',
    message: {
      to: { channel: 'email', target },
      templateId: 'otp',
      data: { code: rawSecret(code) }
    }
  })

  const first = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [effect()]
  })
  const replay = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [effect()]
  })

  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(store.__unsafeMessages.size, 1)
  assert.equal([...store.__unsafeMessages.values()][0].messageId, 'replay_1')

  const existing = [...store.__unsafeMessages.values()][0]
  store.__unsafeMessages.set(existing.messageId, {
    ...existing,
    status: 'claimed',
    attempts: 0
  })
  const claimedReplay = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [effect()]
  })
  assert.equal(claimedReplay.ok, true)

  store.__unsafeMessages.set(existing.messageId, {
    ...existing,
    status: 'dispatched',
    attempts: 0
  })
  const dispatchedReplay = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [effect()]
  })
  assert.equal(dispatchedReplay.ok, true)

  const changedSecret = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [effect('user@example.test', '654321')]
  })
  const changedRecipient = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [effect('attacker@example.test')]
  })
  assert.equal(changedSecret.ok, false)
  assert.equal(changedSecret.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(changedRecipient.ok, false)
  assert.equal(changedRecipient.error.reason, 'STORE_UNAVAILABLE')

  store.__unsafeMessages.set(existing.messageId, { ...existing, status: 'dead' })
  const terminalReplay = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [effect()]
  })
  assert.equal(terminalReplay.ok, false)
  assert.equal(terminalReplay.error.reason, 'STORE_UNAVAILABLE')
})

test('dispatcher normalizes malformed store failure details without leaking them', async () => {
  const details = { secret: 'must-not-leak' }
  details.self = details
  const dispatcher = createOutboxEffectsDispatcher({
    store: {
      async enqueueBatch() {
        return {
          ok: false,
          error: {
            type: 'component.failure',
            component: 'store',
            reason: 'OUTBOX_ENQUEUE_FAILED',
            details
          }
        }
      }
    },
    sealer: fakeSealer(),
    idGenerator: () => 'message_1'
  })

  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'best-effort',
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.failed, [{
    index: 0,
    type: 'delivery',
    reason: 'STORE_UNAVAILABLE'
  }])
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/)
})

test('dispatcher rejects locale beyond the delivery contract bound', async () => {
  const store = memoryOutboxStore()
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer: fakeSealer(),
    idGenerator: () => 'message_1'
  })

  const result = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1', locale: 'x'.repeat(129) },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'oversized-locale',
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })

  assert.equal(result.ok, false)
  assert.equal(store.__unsafeMessages.size, 0)
})

function rawSecret(value) {
  return {
    type: 'raw-secret',
    redacted: '[REDACTED]',
    reveal() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function protectedValue(value) {
  return {
    revealForPersistence() {
      return value
    }
  }
}

function sealedValue(value) {
  return {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'test',
    redacted: '[REDACTED]',
    revealCiphertextForPersistence() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function fakeSealer() {
  return {
    async seal(input) {
      return {
        ok: true,
        value: {
          type: 'sealed-secret',
          algorithm: 'test.v1',
          keyId: 'test',
          redacted: '[REDACTED]',
          expiresAt: input.expiresAt,
          revealCiphertextForPersistence() {
            return `sealed:${input.value.reveal()}`
          },
          toJSON() {
            return '[REDACTED]'
          }
        }
      }
    },
    async unseal(input) {
      const ciphertext = input.value.revealCiphertextForPersistence()
      return typeof ciphertext === 'string' && ciphertext.startsWith('sealed:')
        ? { ok: true, value: rawSecret(ciphertext.slice('sealed:'.length)) }
        : {
            ok: false,
            error: {
              type: 'component.failure',
              component: 'crypto',
              reason: 'CRYPTO_FAILED'
            }
          }
    }
  }
}

function purposeBoundSealer() {
  return {
    async seal(input) {
      const plaintext = input.value.reveal()
      const purpose = input.purpose
      return {
        ok: true,
        value: {
          type: 'sealed-secret',
          algorithm: 'test.v1',
          keyId: 'test',
          redacted: '[REDACTED]',
          expiresAt: input.expiresAt,
          revealCiphertextForPersistence() {
            return `${purpose}\u0000${plaintext}`
          },
          toJSON() {
            return '[REDACTED]'
          }
        }
      }
    },
    async unseal(input) {
      const ciphertext = input.value.revealCiphertextForPersistence()
      const prefix = `${input.purpose}\u0000`
      return typeof ciphertext === 'string' && ciphertext.startsWith(prefix)
        ? { ok: true, value: rawSecret(ciphertext.slice(prefix.length)) }
        : {
            ok: false,
            error: {
              type: 'component.failure',
              component: 'crypto',
              reason: 'CRYPTO_FAILED'
            }
          }
    }
  }
}

function memoryOutboxStore() {
  const messages = new Map()
  const idempotencyKeys = new Map()
  return {
    __unsafeMessages: messages,
    async enqueueBatch(input) {
      const acknowledged = []
      const staged = []
      for (const message of input.messages) {
        if (message.idempotencyKey !== undefined) {
          const idempotencyKey = `${message.tenantId}\u0000${message.idempotencyKey}`
          const existingId = idempotencyKeys.get(idempotencyKey)
          if (existingId !== undefined) {
            const existing = messages.get(existingId)
            if (!existing) throw new Error('Corrupt test store')
            acknowledged.push(existing)
            continue
          }
          staged.push({ idempotencyKey, message })
        }
        if (messages.has(message.messageId)) {
          return {
            ok: false,
            error: {
              type: 'component.failure',
              component: 'store',
              reason: 'OUTBOX_ENQUEUE_FAILED'
            }
          }
        }
        acknowledged.push(message)
      }
      for (const { idempotencyKey, message } of staged) {
        idempotencyKeys.set(idempotencyKey, message.messageId)
      }
      for (const message of acknowledged) {
        if (!messages.has(message.messageId)) messages.set(message.messageId, message)
      }
      return { ok: true, value: acknowledged }
    }
  }
}
