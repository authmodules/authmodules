import test from 'node:test'
import assert from 'node:assert/strict'
import { createSyncDeliveryEffects } from '../src/index.ts'

test('dispatches delivery effects and reports best-effort failures', async () => {
  let receivedContext
  const effects = createSyncDeliveryEffects({
    transport: {
      async send(input) {
        receivedContext = input.context
        return { ok: true, value: { providerMessageId: 'provider_1', acceptedAt: new Date('2026-01-01T00:00:00.000Z') } }
      }
    }
  })

  const result = await effects.dispatch({
    context: {
      tenantId: 'tenant_1',
      requestId: 'request_1',
      metadata: { trace: ['edge', { sampled: true }] },
      actor: { type: 'account', accountId: 'must-not-cross-boundary' },
      ip: '127.0.0.1',
      policyInput: { role: 'must-not-cross-boundary' }
    },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'dispatch-success',
        message: {
          to: { channel: 'email', target: 'user@example.test' },
          templateId: 'otp',
          data: { attempts: [1, { accepted: true }] }
        }
      },
      {
        type: 'unknown',
        dispatchPolicy: 'best-effort'
      }
    ]
  })

  assert.equal(result.ok, true)
  assert.deepEqual(receivedContext, {
    tenantId: 'tenant_1',
    requestId: 'request_1',
    metadata: { trace: ['edge', { sampled: true }] }
  })
  assert.deepEqual(result.value.dispatched, [{ index: 0, type: 'delivery' }])
  assert.deepEqual(result.value.failed, [{ index: 1, type: 'delivery', reason: 'SIDE_EFFECT_FAILED' }])
})

test('each transport call receives an isolated snapshot of context and message', async () => {
  const seen = []
  const sharedMessage = {
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'notification'
  }
  const effects = createSyncDeliveryEffects({
    transport: {
      async send(input) {
        seen.push([input.context.tenantId, input.message.to.target])
        Object.assign(input.context, { tenantId: 'mutated_tenant' })
        Object.assign(input.message.to, { target: 'attacker@example.test' })
        return { ok: true, value: { acceptedAt: input.now } }
      }
    }
  })

  const result = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'isolation-first',
        message: sharedMessage
      },
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'isolation-second',
        message: sharedMessage
      }
    ]
  })

  assert.equal(result.ok, true)
  assert.deepEqual(seen, [
    ['tenant_1', 'user@example.test'],
    ['tenant_1', 'user@example.test']
  ])
  assert.equal(sharedMessage.to.target, 'user@example.test')
})

test('dispatcher reads a stateful effects property exactly once before validation', async () => {
  let sends = 0
  const dispatcher = createSyncDeliveryEffects({
    transport: {
      async send() {
        sends += 1
        return {
          ok: true,
          value: { acceptedAt: new Date('2026-01-01T00:00:00.000Z') }
        }
      }
    }
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
  assert.equal(sends, 1)
})

test('required delivery failure fails the dispatch', async () => {
  const effects = createSyncDeliveryEffects({
    transport: {
      async send() {
        return {
          ok: false,
          error: {
            reason: 'DELIVERY_FAILED',
            details: { provider: 'smtp' }
          }
        }
      }
    }
  })

  const result = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'dispatch-required-failure',
        message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
      }
    ]
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.component, 'effects')
  assert.equal(result.error.reason, 'DELIVERY_FAILED')
})

test('preserves a delivery failure reason at the contract limit', async () => {
  const reason = 'R'.repeat(512)
  const effects = createSyncDeliveryEffects({
    transport: {
      async send() {
        return {
          ok: false,
          error: { reason }
        }
      }
    }
  })

  const result = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'contract-limit-reason',
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, reason)
})

test('validates the complete batch before sending required effects', async () => {
  let calls = 0
  const effects = createSyncDeliveryEffects({
    transport: {
      async send(input) {
        calls += 1
        return { ok: true, value: { acceptedAt: input.now } }
      }
    }
  })

  const result = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'batch-first',
        message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'first' }
      },
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'batch-invalid-second',
        message: { to: { channel: 'email', target: '' }, templateId: 'invalid-second' }
      }
    ]
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'SIDE_EFFECT_FAILED')
  assert.equal(calls, 0)
})

test('thrown delivery transport error is mapped to delivery failure', async () => {
  const effects = createSyncDeliveryEffects({
    transport: {
      async send() {
        throw new Error('smtp down')
      }
    }
  })

  const result = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'transport-throws',
        message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
      }
    ]
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'DELIVERY_FAILED')
})

test('rejects invalid configuration and malformed dispatch input without throwing', async () => {
  assert.throws(() => createSyncDeliveryEffects({}), /transport/)

  const effects = createSyncDeliveryEffects({
    transport: {
      async send() {
        throw new Error('must not run')
      }
    }
  })

  const result = await effects.dispatch({ effects: [] })
  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'SIDE_EFFECT_FAILED')
})

test('does not deliver expired effects and rejects malformed transport success', async () => {
  let calls = 0
  const effects = createSyncDeliveryEffects({
    transport: {
      async send() {
        calls += 1
        return { ok: true, value: { providerMessageId: 'missing-accepted-at' } }
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')

  const expired = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'best-effort',
      expiresAt: now,
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })
  assert.equal(expired.ok, true)
  assert.equal(calls, 0)
  assert.equal(expired.value.failed[0].reason, 'SIDE_EFFECT_FAILED')

  const malformed = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'malformed-success',
      message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
    }]
  })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error.reason, 'DELIVERY_FAILED')
})

test('rejects cyclic context metadata and delivery data before transport', async () => {
  let calls = 0
  const effects = createSyncDeliveryEffects({
    transport: {
      async send() {
        calls += 1
        return { ok: true, value: { acceptedAt: new Date('2026-01-01T00:00:00.000Z') } }
      }
    }
  })
  const cyclic = {}
  cyclic.self = cyclic
  const now = new Date('2026-01-01T00:00:00.000Z')

  const invalidContext = await effects.dispatch({ context: { tenantId: 'tenant_1', metadata: cyclic }, now, effects: [] })
  const invalidData = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'cyclic-data',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: cyclic
      }
    }]
  })
  const disguised = await effects.dispatch({
    context: {
      tenantId: 'tenant_1',
      metadata: {
        verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
      }
    },
    now,
    effects: []
  })
  const disguisedData = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'disguised-data',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: {
          verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
        }
      }
    }]
  })

  assert.equal(invalidContext.ok, false)
  assert.equal(invalidData.ok, false)
  assert.equal(disguised.ok, false)
  assert.equal(disguisedData.ok, false)
  assert.equal(calls, 0)
})

test('accepts only contract-complete shallow delivery secrets', async () => {
  let calls = 0
  let captured
  const effects = createSyncDeliveryEffects({
    transport: {
      async send(input) {
        calls += 1
        captured = input
        return { ok: true, value: { acceptedAt: new Date('2026-01-01T00:00:00.000Z') } }
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const base = {
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'shallow-secrets',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp'
      }
    }]
  }
  const raw = {
    type: 'raw-secret',
    redacted: '123',
    reveal: () => '123456',
    toJSON: () => '[REDACTED]'
  }

  const valid = await effects.dispatch({
    ...base,
    effects: [{ ...base.effects[0], message: { ...base.effects[0].message, data: { code: raw } } }]
  })
  const nested = await effects.dispatch({
    ...base,
    effects: [{ ...base.effects[0], message: { ...base.effects[0].message, data: { nested: { code: raw } } } }]
  })
  const incomplete = await effects.dispatch({
    ...base,
    effects: [{
      ...base.effects[0],
      message: { ...base.effects[0].message, data: { code: { reveal: () => '123456' } } }
    }]
  })

  assert.equal(valid.ok, true)
  assert.equal(nested.ok, false)
  assert.equal(incomplete.ok, false)
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(captured.message.data.code), '"[REDACTED]"')
})

test('snapshots stateful transport results and enforces one aggregate raw-secret budget', async () => {
  let acceptedReads = 0
  let providerReads = 0
  let calls = 0
  class StatefulDate extends Date {
    reads = 0

    override getTime(): number {
      this.reads += 1
      return this.reads === 1
        ? Date.prototype.getTime.call(this)
        : Number.NaN
    }
  }
  const acceptedAt = new StatefulDate('2026-01-01T00:00:00.000Z')
  const effects = createSyncDeliveryEffects({
    transport: {
      async send() {
        calls += 1
        return {
          ok: true,
          value: {
            get acceptedAt() {
              acceptedReads += 1
              return acceptedReads === 1 ? acceptedAt : new Date('invalid')
            },
            get providerMessageId() {
              providerReads += 1
              return providerReads === 1 ? 'provider_stateful' : ''
            }
          }
        }
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const baseEffect = {
    type: 'delivery',
    dispatchPolicy: 'required',
    idempotencyKey: 'aggregate-secret-budget',
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp'
    }
  }
  const valid = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [baseEffect]
  })
  const oversized = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      ...baseEffect,
      message: {
        ...baseEffect.message,
        data: {
          first: secret('a'.repeat(600_000)),
          second: secret('b'.repeat(600_000))
        }
      }
    }]
  })

  assert.equal(valid.ok, true)
  assert.equal(acceptedAt.reads, 0)
  assert.equal(acceptedReads, 1)
  assert.equal(providerReads, 1)
  assert.equal(oversized.ok, false)
  assert.equal(calls, 1)
})

test('rechecks effect expiry immediately before every transport call', async () => {
  const initial = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date('2026-01-01T00:00:01.000Z')
  const times = [initial, expiresAt]
  const sent = []
  const effects = createSyncDeliveryEffects({
    now() {
      return times.shift()
    },
    transport: {
      async send(input) {
        sent.push(input.message.templateId)
        return { ok: true, value: { acceptedAt: input.now } }
      }
    }
  })

  const result = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now: initial,
    effects: [
      {
        type: 'delivery',
        dispatchPolicy: 'required',
        idempotencyKey: 'deadline-first',
        expiresAt,
        message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'first' }
      },
      {
        type: 'delivery',
        dispatchPolicy: 'best-effort',
        expiresAt,
        message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'second' }
      }
    ]
  })

  assert.equal(result.ok, true)
  assert.deepEqual(sent, ['first'])
  assert.deepEqual(result.value.failed, [{
    index: 1,
    type: 'delivery',
    reason: 'SIDE_EFFECT_FAILED'
  }])
})

test('fails closed for a regressing clock and secret-bearing redaction labels', async () => {
  const initial = new Date('2026-01-01T00:00:00.000Z')
  let serializedSecret
  const effects = createSyncDeliveryEffects({
    now: () => new Date('2025-12-31T23:59:59.000Z'),
    transport: {
      async send(input) {
        serializedSecret = JSON.stringify(input.message.data.code)
        return { ok: true, value: { acceptedAt: input.now } }
      }
    }
  })
  const result = await effects.dispatch({
    context: { tenantId: 'tenant_1' },
    now: initial,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'regressing-clock',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: { code: secret('123456', 'code=123456') }
      }
    }]
  })

  assert.equal(result.ok, false)
  assert.equal(serializedSecret, undefined)

  const safeEffects = createSyncDeliveryEffects({
    transport: {
      async send(input) {
        serializedSecret = JSON.stringify(input.message.data.code)
        return { ok: true, value: { acceptedAt: input.now } }
      }
    }
  })
  const safeResult = await safeEffects.dispatch({
    context: { tenantId: 'tenant_1' },
    now: initial,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'safe-redaction',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: { code: secret('123456', 'code=123456') }
      }
    }]
  })
  assert.equal(safeResult.ok, true)
  assert.equal(serializedSecret, '"[REDACTED]"')
})

function secret(value, redacted = '[REDACTED]') {
  return {
    type: 'raw-secret',
    redacted,
    reveal: () => value,
    toJSON: () => redacted
  }
}
