import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeliverySendInput } from '@authmodules/contracts/delivery'
import { createNodeSecretSealer, rawSecret } from '../packages/crypto-node/src/index.ts'
import { createOutboxEffectsDispatcher, outboxSecretPurpose } from '../packages/effects-outbox/src/index.ts'
import { createOutboxWorker } from '../packages/outbox-worker/src/index.ts'
import { createMemoryOutboxStore } from '../packages/testkit/src/index.ts'

test('official outbox dispatcher output is accepted and delivered by the official worker', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const store = createMemoryOutboxStore()
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(7)),
    keyId: 'outbox-test'
  })
  const dispatcher = createOutboxEffectsDispatcher({
    store,
    sealer,
    now: () => new Date(now.getTime()),
    idGenerator: () => 'message_1'
  })
  const dispatched = await dispatcher.dispatch({
    context: { tenantId: 'tenant_1' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'otp:challenge_1',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: { code: rawSecret('123456') }
      }
    }]
  })
  assert.equal(dispatched.ok, true)
  assert.equal(outboxSecretPurpose('tenant_1', 'message_1').includes('\u0000'), false)

  let deliveryInput
  const worker = createOutboxWorker({
    store,
    sealer,
    workerId: 'worker_1',
    transport: {
      async send(input) {
        deliveryInput = input
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })
  const delivered = await worker.runOnce({ now })

  assert.equal(delivered.ok, true)
  assert.deepEqual(delivered.value, { claimed: 1, dispatched: 1, failed: 0 })
  assert.equal(deliveryInput.message.data.code.reveal(), '123456')
  assert.equal(deliveryInput.idempotencyKey, 'otp:challenge_1')
})

test('worker retry after post-delivery mark failure reuses the same idempotency key', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const retriedAt = new Date(now.getTime() + 20000)
  const memoryStore = createMemoryOutboxStore()
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(8)),
    keyId: 'outbox-retry-test'
  })
  const dispatcher = createOutboxEffectsDispatcher({
    store: memoryStore,
    sealer,
    now: () => new Date(now.getTime()),
    idGenerator: () => 'retry_message'
  })
  const queued = await dispatcher.dispatch({
    context: { tenantId: 'tenant_retry' },
    now,
    effects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'otp:retry_challenge',
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'otp',
        data: { code: rawSecret('654321') }
      }
    }]
  })
  assert.equal(queued.ok, true)

  let rejectFirstMark = true
  const store = {
    ...memoryStore,
    async markDispatched(input) {
      if (rejectFirstMark) {
        rejectFirstMark = false
        return {
          ok: false,
          error: {
            type: 'component.failure',
            component: 'store',
            reason: 'OUTBOX_LEASE_CONFLICT'
          }
        }
      }
      return memoryStore.markDispatched(input)
    }
  }
  const deliveries: DeliverySendInput[] = []
  const worker = createOutboxWorker({
    store,
    sealer,
    workerId: 'retry_worker',
    leaseSeconds: 10,
    transport: {
      async send(input) {
        deliveries.push(input)
        return { ok: true, value: { acceptedAt: input.now } }
      }
    }
  })

  const first = await worker.runOnce({ now })
  const second = await worker.runOnce({ now: retriedAt })

  assert.equal(first.ok, false)
  assert.deepEqual(second, { ok: true, value: { claimed: 1, dispatched: 1, failed: 0 } })
  assert.equal(deliveries.length, 2)
  assert.equal(deliveries[0].idempotencyKey, 'otp:retry_challenge')
  assert.equal(deliveries[1].idempotencyKey, deliveries[0].idempotencyKey)
})
