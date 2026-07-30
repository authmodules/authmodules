import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutboxWorker as createProductionOutboxWorker } from '../src/index.ts'
import { isClaimedMessage } from '../src/worker/validation.ts'

test('lease validation rejects non-claimed and exhausted records', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const message = {
    tenantId: 'tenant_1',
    messageId: 'message_1',
    context: { tenantId: 'tenant_1' },
    secretPurpose: secretPurpose('tenant_1', 'message_1'),
    type: 'delivery',
    message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
    dispatchPolicy: 'required',
    idempotencyKey: 'message-validation',
    status: 'claimed',
    attempts: 0,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
    lease: {
      workerId: 'worker_1',
      leaseId: 'lease_1',
      leaseUntil: new Date(now.getTime() + 30000)
    }
  }

  assert.equal(isClaimedMessage({ ...message, status: 'pending' }), false)
  assert.equal(isClaimedMessage({ ...message, attempts: 3 }), false)
  assert.equal(isClaimedMessage({ ...message, secretPurpose: 'p'.repeat(4096) }), false)
  assert.equal(isClaimedMessage({ ...message, secretPurpose: 'p'.repeat(4097) }), false)
  assert.equal(isClaimedMessage({
    ...message,
    message: {
      ...message.message,
      data: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
        `part_${index}`,
        'x'.repeat(65536)
      ]))
    }
  }), false)
  assert.equal(isClaimedMessage(message), true)
})

test('runOnce claims messages, sends them, and marks successful delivery', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const calls = []
  let acceptedAtReads = 0
  let providerMessageIdReads = 0
  class StatefulDate extends Date {
    reads = 0

    override getTime(): number {
      this.reads += 1
      return this.reads === 1
        ? Date.prototype.getTime.call(this)
        : Number.NaN
    }
  }
  const acceptedAt = new StatefulDate('2026-01-01T00:00:01.000Z')
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch(input) {
        calls.push(['claimBatch', input])
        return {
          ok: true,
          value: [
            {
              tenantId: 'tenant_1',
              messageId: 'message_1',
              type: 'delivery',
              dispatchPolicy: 'required',
              status: 'claimed',
              attempts: 0,
              maxAttempts: 3,
              availableAt: now,
              createdAt: now,
              updatedAt: now,
              idempotencyKey: 'otp:challenge_1',
              context: {
                tenantId: 'tenant_1',
                locale: 'en',
                actor: { type: 'account', accountId: 'must-not-cross-boundary' },
                ip: '127.0.0.1',
                policyInput: { role: 'must-not-cross-boundary' }
              },
              secretPurpose: secretPurpose('tenant_1', 'message_1'),
              message: {
                to: { channel: 'email', target: 'user@example.test' },
                templateId: 'otp'
              },
              lease: {
                workerId: 'worker_1',
                leaseId: 'lease_1',
                leaseUntil: new Date(now.getTime() + 30000)
              }
            }
          ]
        }
      },
      async markDispatched(input) {
        calls.push(['markDispatched', input])
        return { ok: true, value: undefined }
      },
      async markFailed() {
        throw new Error('markFailed should not be called')
      }
    },
    transport: {
      async send(input) {
        calls.push(['send', input])
        return {
          ok: true,
          value: {
            get providerMessageId() {
              providerMessageIdReads += 1
              return providerMessageIdReads === 1 ? 'smtp_1' : ''
            },
            get acceptedAt() {
              acceptedAtReads += 1
              return acceptedAtReads === 1 ? acceptedAt : new Date('invalid')
            }
          }
        }
      }
    }
  })

  const result = await worker.runOnce({
    now,
    tenantId: 'tenant_1',
    limit: 1
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    claimed: 1,
    dispatched: 1,
    failed: 0
  })
  assert.equal(calls[0][0], 'claimBatch')
  assert.equal(calls[0][1].tenantId, 'tenant_1')
  assert.equal(calls[1][0], 'send')
  assert.equal(calls[1][1].context.tenantId, 'tenant_1')
  assert.equal(calls[1][1].context.locale, 'en')
  assert.deepEqual(calls[1][1].context, { tenantId: 'tenant_1', locale: 'en' })
  assert.equal(calls[1][1].idempotencyKey, 'otp:challenge_1')
  assert.equal(calls[2][0], 'markDispatched')
  assert.equal(calls[2][1].leaseId, 'lease_1')
  assert.equal(acceptedAtReads, 1)
  assert.equal(providerMessageIdReads, 1)
  assert.equal(acceptedAt.reads, 0)
})

test('tenant-scoped workers reject a claimed message from another tenant', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let sent = false
  let marked = false
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_2',
            messageId: 'message_foreign',
            context: { tenantId: 'tenant_2' },
            secretPurpose: secretPurpose('tenant_2', 'message_foreign'),
            type: 'delivery',
            message: {
              to: { channel: 'email', target: 'foreign@example.test' },
              templateId: 'otp'
            },
            dispatchPolicy: 'required',
            idempotencyKey: 'message-foreign',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_foreign',
              leaseUntil: new Date(now.getTime() + 30000)
            }
          }]
        }
      },
      async markDispatched() {
        marked = true
        return { ok: true, value: undefined }
      },
      async markFailed() {
        marked = true
        return { ok: true, value: undefined }
      }
    },
    transport: {
      async send() {
        sent = true
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  const result = await worker.runOnce({
    now,
    tenantId: 'tenant_1',
    limit: 1
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'OUTBOX_RECORD_INVALID')
  assert.equal(sent, false)
  assert.equal(marked, false)
})

test('worker ignores an untrusted future provider timestamp when acknowledging delivery', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const leaseUntil = new Date(now.getTime() + 30000)
  const acceptedAt = new Date(leaseUntil.getTime() + 1)
  let markInput
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_expired_lease',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'message-expired-lease',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'message_expired_lease'),
            message: {
              to: { channel: 'email', target: 'user@example.test' },
              templateId: 'otp',
              data: { code: sealedValue('123456') }
            },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_1',
              leaseUntil
            }
          }]
        }
      },
      async markDispatched(input) {
        markInput = input
        return input.now < leaseUntil
          ? { ok: true, value: undefined }
          : {
              ok: false,
              error: { type: 'component.failure', component: 'store', reason: 'OUTBOX_LEASE_CONFLICT' }
            }
      }
    },
    transport: {
      async send() {
        return { ok: true, value: { acceptedAt } }
      }
    }
  })

  assert.deepEqual(await worker.runOnce({ now }), {
    ok: true,
    value: { claimed: 1, dispatched: 1, failed: 0 }
  })
  assert.ok(markInput.now >= now)
  assert.ok(markInput.now < leaseUntil)
})

test('worker does not acknowledge a delivery when local send time outlives the lease', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const leaseUntil = new Date(now.getTime() + 50)
  const leaseFailure = {
    ok: false,
    error: { type: 'component.failure', component: 'store', reason: 'OUTBOX_LEASE_CONFLICT' }
  }
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_slow_send',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'message-slow-send',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'message_slow_send'),
            message: {
              to: { channel: 'email', target: 'user@example.test' },
              templateId: 'otp'
            },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_slow_send',
              leaseUntil
            }
          }]
        }
      },
      async renewLease(input) {
        return {
          ok: true,
          value: {
            workerId: input.workerId,
            leaseId: input.leaseId,
            leaseUntil
          }
        }
      },
      async markDispatched(input) {
        return input.now < leaseUntil ? { ok: true, value: undefined } : leaseFailure
      }
    },
    transport: {
      async send() {
        await new Promise((resolve) => setTimeout(resolve, 75))
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  assert.deepEqual(await worker.runOnce({ now }), leaseFailure)
})

test('worker claims each sequential batch item with a fresh lease', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let sends = 0
  let dispatched = 0
  let nextMessage = 0
  const messageIds = ['first', 'second']
  const message = (messageId, claimedAt) => ({
    tenantId: 'tenant_1',
    messageId,
    type: 'delivery',
    dispatchPolicy: 'required',
    idempotencyKey: `delivery-${messageId}`,
    status: 'claimed',
    attempts: 0,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
    context: { tenantId: 'tenant_1' },
    secretPurpose: secretPurpose('tenant_1', messageId),
    message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
    lease: {
      workerId: 'worker_1',
      leaseId: `lease_${messageId}`,
      leaseUntil: new Date(claimedAt.getTime() + 50)
    }
  })
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch(input) {
        const claimedIds = messageIds.slice(nextMessage, nextMessage + input.limit)
        nextMessage += claimedIds.length
        return {
          ok: true,
          value: claimedIds.map((messageId) => message(messageId, input.now))
        }
      },
      async markDispatched() {
        dispatched += 1
        return { ok: true, value: undefined }
      }
    },
    transport: {
      async send() {
        sends += 1
        if (sends === 1) await new Promise((resolve) => setTimeout(resolve, 75))
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  const result = await worker.runOnce({ now, limit: 2 })
  assert.deepEqual(result, {
    ok: true,
    value: {
      claimed: 2,
      dispatched: 2,
      failed: 0
    }
  })
  assert.equal(sends, 2)
  assert.equal(dispatched, 2)
})

test('worker continues with valid claimed items after a malformed batch item', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let sends = 0
  let dispatched = 0
  let claims = 0
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    limit: 2,
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        claims += 1
        return {
          ok: true,
          value: claims === 1
            ? [{ status: 'claimed', providerSecret: 'must-not-cross' }]
            : [{
              tenantId: 'tenant_1',
              messageId: 'valid_after_poison',
              type: 'delivery',
              dispatchPolicy: 'required',
              idempotencyKey: 'valid-after-poison',
              status: 'claimed',
              attempts: 0,
              maxAttempts: 3,
              availableAt: now,
              createdAt: now,
              updatedAt: now,
              context: { tenantId: 'tenant_1' },
              secretPurpose: secretPurpose('tenant_1', 'valid_after_poison'),
              message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
              lease: {
                workerId: 'worker_1',
                leaseId: 'lease_valid',
                leaseUntil: new Date(now.getTime() + 30000)
              }
            }]
        }
      },
      async markDispatched() {
        dispatched += 1
        return { ok: true, value: undefined }
      }
    },
    transport: {
      async send() {
        sends += 1
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  const result = await worker.runOnce({ now })
  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'OUTBOX_RECORD_INVALID')
  assert.equal(sends, 1)
  assert.equal(dispatched, 1)
  assert.equal(JSON.stringify(result).includes('must-not-cross'), false)
})

test('worker marks a message terminal when it expires during unsealing', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let sends = 0
  let failedInput
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: {
      async unseal(input) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return fakeSealer().unseal(input)
      }
    },
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'expires_during_unseal',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'expires-during-unseal',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            expiresAt: new Date(now.getTime() + 5),
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'expires_during_unseal'),
            message: {
              to: { channel: 'email', target: 'user@example.test' },
              templateId: 'otp',
              data: { code: sealedValue('123456') }
            },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_expiring',
              leaseUntil: new Date(now.getTime() + 30000)
            }
          }]
        }
      },
      async markFailed(input) {
        failedInput = input
        return { ok: true, value: undefined }
      }
    },
    transport: {
      async send() {
        sends += 1
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  const result = await worker.runOnce({ now })
  assert.equal(result.ok, true)
  assert.equal(result.value.failed, 1)
  assert.equal(sends, 0)
  assert.equal(failedInput.terminal, true)
  assert.equal(failedInput.retryAt, undefined)
})

test('worker does not unseal or send when lease renewal outlives message expiry', async () => {
  for (const delayedRenewal of [1, 2]) {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const messageId = `expires_during_renew_${delayedRenewal}`
    let renewals = 0
    let unseals = 0
    let sends = 0
    let failedInput
    const worker = createOutboxWorker({
      workerId: 'worker_1',
      sealer: {
        async unseal(input) {
          unseals += 1
          return fakeSealer().unseal(input)
        }
      },
      store: {
        async claimBatch() {
          return {
            ok: true,
            value: [{
              tenantId: 'tenant_1',
              messageId,
              type: 'delivery',
              dispatchPolicy: 'required',
              idempotencyKey: messageId,
              status: 'claimed',
              attempts: 0,
              maxAttempts: 3,
              expiresAt: new Date(now.getTime() + 5),
              availableAt: now,
              createdAt: now,
              updatedAt: now,
              context: { tenantId: 'tenant_1' },
              secretPurpose: secretPurpose('tenant_1', messageId),
              message: {
                to: { channel: 'email', target: 'user@example.test' },
                templateId: 'otp',
                data: { code: sealedValue('123456') }
              },
              lease: {
                workerId: 'worker_1',
                leaseId: `lease_${delayedRenewal}`,
                leaseUntil: new Date(now.getTime() + 30000)
              }
            }]
          }
        },
        async renewLease(input) {
          renewals += 1
          if (renewals === delayedRenewal) {
            await new Promise((resolve) => setTimeout(resolve, 15))
          }
          return {
            ok: true,
            value: {
              leaseId: input.leaseId,
              workerId: input.workerId,
              leaseUntil: new Date(input.now.getTime() + 30000)
            }
          }
        },
        async markFailed(input) {
          failedInput = input
          return { ok: true, value: undefined }
        }
      },
      transport: {
        async send() {
          sends += 1
          return { ok: true, value: { acceptedAt: now } }
        }
      }
    })

    const result = await worker.runOnce({ now })

    assert.equal(result.ok, true)
    assert.equal(result.value.failed, 1)
    assert.equal(unseals, delayedRenewal === 1 ? 0 : 1)
    assert.equal(sends, 0)
    assert.equal(failedInput.terminal, true)
  }
})

test('worker does not send after secret unsealing outlives the lease', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let unseals = 0
  let sends = 0
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: {
      async unseal(input) {
        unseals += 1
        await new Promise((resolve) => setTimeout(resolve, 75))
        return fakeSealer().unseal(input)
      }
    },
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_slow_unseal',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'message-slow-unseal',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'message_slow_unseal'),
            message: {
              to: { channel: 'email', target: 'user@example.test' },
              templateId: 'otp',
              data: { code: sealedValue('123456') }
            },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_1',
              leaseUntil: new Date(now.getTime() + 50)
            }
          }]
        }
      },
      async renewLease(input) {
        const leaseUntil = new Date(now.getTime() + 50)
        if (input.now >= leaseUntil) {
          return {
            ok: false,
            error: {
              type: 'component.failure',
              component: 'store',
              reason: 'OUTBOX_LEASE_CONFLICT'
            }
          }
        }
        return {
          ok: true,
          value: {
            workerId: input.workerId,
            leaseId: input.leaseId,
            leaseUntil
          }
        }
      }
    },
    transport: {
      async send() {
        sends += 1
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  const result = await worker.runOnce({ now })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'OUTBOX_LEASE_CONFLICT')
  assert.equal(unseals, 1)
  assert.equal(sends, 0)
})

test('worker falls back to messageId as provider idempotency key', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let sendInput
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_fallback',
            type: 'delivery',
            dispatchPolicy: 'best-effort',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'message_fallback'),
            message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_1',
              leaseUntil: new Date(now.getTime() + 30000)
            }
          }]
        }
      },
      async markDispatched() {
        return { ok: true, value: undefined }
      }
    },
    transport: {
      async send(input) {
        sendInput = input
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  assert.equal((await worker.runOnce({ now })).ok, true)
  assert.equal(sendInput.idempotencyKey, 'message_fallback')
})

test('runOnce marks failed deliveries with retry time', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let failedCall
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    retryDelaySeconds: 30,
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [
            {
              tenantId: 'tenant_1',
              messageId: 'message_1',
              type: 'delivery',
              dispatchPolicy: 'required',
              idempotencyKey: 'message-delivery-failure',
              status: 'claimed',
              attempts: 0,
              maxAttempts: 3,
              availableAt: now,
              createdAt: now,
              updatedAt: now,
              context: { tenantId: 'tenant_1' },
              secretPurpose: secretPurpose('tenant_1', 'message_1'),
              message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
              lease: {
                workerId: 'worker_1',
                leaseId: 'lease_1',
                leaseUntil: new Date(now.getTime() + 30000)
              }
            }
          ]
        }
      },
      async markDispatched() {
        throw new Error('markDispatched should not be called')
      },
      async markFailed(input) {
        failedCall = input
        return { ok: true, value: undefined }
      }
    },
    transport: {
      async send() {
        return {
          ok: false,
          error: { reason: 'DELIVERY_FAILED' }
        }
      }
    }
  })

  const result = await worker.runOnce({ now })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    claimed: 1,
    dispatched: 0,
    failed: 1
  })
  assert.equal(failedCall.reason, 'DELIVERY_FAILED')
  assert.ok(failedCall.retryAt.getTime() >= now.getTime() + 30000)
  assert.ok(failedCall.retryAt.getTime() < now.getTime() + 30100)
})

test('runOnce maps thrown transport errors to failed deliveries', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let failedCall
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    retryDelaySeconds: 30,
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [
            {
              tenantId: 'tenant_1',
              messageId: 'message_1',
              type: 'delivery',
              dispatchPolicy: 'required',
              idempotencyKey: 'message-thrown-transport',
              status: 'claimed',
              attempts: 0,
              maxAttempts: 3,
              availableAt: now,
              createdAt: now,
              updatedAt: now,
              context: { tenantId: 'tenant_1' },
              secretPurpose: secretPurpose('tenant_1', 'message_1'),
              message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
              lease: {
                workerId: 'worker_1',
                leaseId: 'lease_1',
                leaseUntil: new Date(now.getTime() + 30000)
              }
            }
          ]
        }
      },
      async markDispatched() {
        throw new Error('markDispatched should not be called')
      },
      async markFailed(input) {
        failedCall = input
        return { ok: true, value: undefined }
      }
    },
    transport: {
      async send() {
        throw new Error('smtp down')
      }
    }
  })

  const result = await worker.runOnce({ now })

  assert.deepEqual(result, {
    ok: true,
    value: {
      claimed: 1,
      dispatched: 0,
      failed: 1
    }
  })
  assert.equal(failedCall.reason, 'DELIVERY_FAILED')
})

test('runOnce unseals secrets only at the transport boundary', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let delivered
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_1',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'message-unseal-boundary',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: {
              tenantId: 'tenant_1',
              requestId: 'request_1',
              metadata: { trace: ['worker', { sampled: true }] }
            },
            secretPurpose: secretPurpose('tenant_1', 'message_1'),
            message: {
              to: { channel: 'email', target: 'user@example.test' },
              templateId: 'otp',
              data: {
                code: sealedValue('123456'),
                attempts: [1, { accepted: true }]
              }
            },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_1',
              leaseUntil: new Date(now.getTime() + 30000)
            }
          }]
        }
      },
      async markDispatched() {
        return { ok: true, value: undefined }
      },
      async markFailed() {
        throw new Error('markFailed should not be called')
      }
    },
    transport: {
      async send(input) {
        delivered = input
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  const result = await worker.runOnce({ now })

  assert.equal(result.ok, true)
  assert.equal(delivered.context.requestId, 'request_1')
  assert.deepEqual(delivered.context.metadata, { trace: ['worker', { sampled: true }] })
  assert.equal(delivered.message.data.code.reveal(), '123456')
  assert.deepEqual(delivered.message.data.attempts, [1, { accepted: true }])
})

test('runOnce retries transient unseal failures', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let failedCall
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    retryDelaySeconds: 30,
    sealer: {
      async unseal() {
        return {
          ok: false,
          error: { type: 'component.failure', component: 'crypto', reason: 'CRYPTO_FAILED' }
        }
      }
    },
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_retry_unseal',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'message-retry-unseal',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'message_retry_unseal'),
            message: {
              to: { channel: 'email', target: 'user@example.test' },
              templateId: 'otp',
              data: { code: sealedValue('123456') }
            },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_1',
              leaseUntil: new Date(now.getTime() + 30000)
            }
          }]
        }
      },
      async markFailed(input) {
        failedCall = input
        return { ok: true, value: undefined }
      }
    },
    transport: {
      async send() {
        throw new Error('transport must not run')
      }
    }
  })

  const result = await worker.runOnce({ now })

  assert.equal(result.ok, true)
  assert.equal(result.value.failed, 1)
  assert.equal(failedCall.terminal, false)
  assert.ok(failedCall.retryAt.getTime() >= now.getTime() + 30000)
  assert.ok(failedCall.retryAt.getTime() < now.getTime() + 30100)
})

test('runOnce propagates mark failures', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const failure = {
    ok: false,
    error: { type: 'component.failure', component: 'store', reason: 'OUTBOX_LEASE_CONFLICT' }
  }
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_1',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'message-mark-failure',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'message_1'),
            message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_1',
              leaseUntil: new Date(now.getTime() + 30000)
            }
          }]
        }
      },
      async markDispatched() {
        return failure
      }
    },
    transport: {
      async send() {
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  assert.deepEqual(await worker.runOnce({ now }), failure)
})

test('worker maps invalid input and thrown store calls to store failures', async () => {
  assert.throws(() => createOutboxWorker(), /options/)
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        throw new Error('database down')
      }
    },
    transport: {
      async send() {
        throw new Error('must not run')
      }
    }
  })

  const invalid = await worker.runOnce({ now: new Date('invalid') })
  const oversizedBatch = await worker.runOnce({ now: new Date('2026-01-01T00:00:00.000Z'), limit: 1001 })
  const thrown = await worker.runOnce({ now: new Date('2026-01-01T00:00:00.000Z') })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.reason, 'OUTBOX_INVALID_INPUT')
  assert.equal(oversizedBatch.ok, false)
  assert.equal(oversizedBatch.error.reason, 'OUTBOX_INVALID_INPUT')
  assert.equal(thrown.ok, false)
  assert.equal(thrown.error.reason, 'STORE_UNAVAILABLE')

  const malformedFailure = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: false,
          error: {
            type: 'component.failure',
            component: 'store',
            reason: 'STORE_UNAVAILABLE',
            providerSecret: 'must-not-cross-boundary'
          }
        }
      }
    },
    transport: {
      async send() {
        throw new Error('must not run')
      }
    }
  })
  const sanitized = await malformedFailure.runOnce({ now: new Date('2026-01-01T00:00:00.000Z') })
  assert.equal(sanitized.ok, false)
  assert.equal(sanitized.error.reason, 'STORE_UNAVAILABLE')
  assert.equal(JSON.stringify(sanitized).includes('must-not-cross-boundary'), false)
})

test('worker maps hostile renewed lease dates to record failures without rejecting', async () => {
  class HostileDate extends Date {
    override getTime(): number {
      throw new Error('hostile getTime')
    }
  }
  const now = new Date('2026-01-01T00:00:00.000Z')
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_1',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'message-hostile-lease',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'message_1'),
            message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_1',
              leaseUntil: new Date(now.getTime() + 30000)
            }
          }]
        }
      },
      async renewLease(input) {
        return {
          ok: true,
          value: {
            leaseId: input.leaseId,
            workerId: input.workerId,
            leaseUntil: new HostileDate('invalid')
          }
        }
      },
      async markDispatched() {
        throw new Error('must not run')
      },
      async markFailed() {
        throw new Error('must not run')
      }
    },
    transport: {
      async send() {
        throw new Error('must not run')
      }
    }
  })

  const result = await worker.runOnce({ now, tenantId: 'tenant_1', limit: 1 })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'OUTBOX_RECORD_INVALID')
})

test('worker treats malformed transport success as a delivery failure', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let failure
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_1',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'message-malformed-success',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'message_1'),
            message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_1',
              leaseUntil: new Date(now.getTime() + 30000)
            }
          }]
        }
      },
      async markFailed(input) {
        failure = input
        return { ok: true, value: undefined }
      }
    },
    transport: {
      async send() {
        return { ok: true, value: { providerMessageId: 'missing-accepted-at' } }
      }
    }
  })

  const result = await worker.runOnce({ now })
  assert.equal(result.ok, true)
  assert.equal(result.value.failed, 1)
  assert.equal(failure.reason, 'DELIVERY_FAILED')
})

test('worker rejects cyclic persisted delivery data before unsealing or delivery', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const cyclic = {}
  cyclic.self = cyclic
  let deliveryData = cyclic
  let delivered = false
  const worker = createOutboxWorker({
    workerId: 'worker_1',
    sealer: fakeSealer(),
    store: {
      async claimBatch() {
        return {
          ok: true,
          value: [{
            tenantId: 'tenant_1',
            messageId: 'message_1',
            type: 'delivery',
            dispatchPolicy: 'required',
            idempotencyKey: 'message-invalid-persisted-data',
            status: 'claimed',
            attempts: 0,
            maxAttempts: 3,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
            context: { tenantId: 'tenant_1' },
            secretPurpose: secretPurpose('tenant_1', 'message_1'),
            message: {
              to: { channel: 'email', target: 'user@example.test' },
              templateId: 'otp',
              data: deliveryData
            },
            lease: {
              workerId: 'worker_1',
              leaseId: 'lease_1',
              leaseUntil: new Date(now.getTime() + 30000)
            }
          }]
        }
      }
    },
    transport: {
      async send() {
        delivered = true
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  const result = await worker.runOnce({ now })
  deliveryData = {
    verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
  }
  const disguised = await worker.runOnce({ now })
  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'OUTBOX_RECORD_INVALID')
  assert.equal(disguised.ok, false)
  assert.equal(disguised.error.reason, 'OUTBOX_RECORD_INVALID')
  assert.equal(delivered, false)
})

function sealedValue(value) {
  return {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'test-key',
    redacted: '[REDACTED]',
    revealCiphertextForPersistence() {
      return `sealed:${value}`
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function secretPurpose(tenantId, messageId) {
  return JSON.stringify(['authmodules.outbox.delivery', tenantId, messageId])
}

function createOutboxWorker(options) {
  if (!options) return createProductionOutboxWorker(options)
  return createProductionOutboxWorker({
    limit: 1,
    ...options,
    store: {
      async renewLease(input) {
        return {
          ok: true,
          value: {
            leaseId: input.leaseId,
            workerId: input.workerId,
            leaseUntil: new Date(input.now.getTime() + input.leaseSeconds * 1000)
          }
        }
      },
      ...options.store
    }
  })
}

function fakeSealer() {
  return {
    async unseal(input) {
      const ciphertext = input.value.revealCiphertextForPersistence()
      return {
        ok: true,
        value: {
          type: 'raw-secret',
          redacted: '[REDACTED]',
          reveal() {
            return ciphertext.slice('sealed:'.length)
          },
          toJSON() {
            return '[REDACTED]'
          }
        }
      }
    }
  }
}
