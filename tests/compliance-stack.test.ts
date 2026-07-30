import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeliverySendInput } from '@authmodules/contracts/delivery'
import { createCookieTokenCarrier } from '../packages/carrier-cookie/src/index.ts'
import { createAuth } from '../packages/core/src/index.ts'
import {
  createNodeCryptoProvider,
  createNodeSecretSealer,
  rawSecret
} from '../packages/crypto-node/src/index.ts'
import { createSmtpDeliveryTransport } from '../packages/delivery-email-smtp/src/index.ts'
import { createOutboxEffectsDispatcher } from '../packages/effects-outbox/src/index.ts'
import { createMemoryAttemptGuard } from '../packages/guard-memory/src/index.ts'
import { createPasswordMethod } from '../packages/method-password/src/index.ts'
import { createOutboxWorker } from '../packages/outbox-worker/src/index.ts'
import {
  complianceSuites,
  createMemoryAuthStore,
  createMemoryOutboxStore,
  createSecretFactory,
  deterministicIdGenerator,
  fixedClock,
  runComplianceSuite
} from '../packages/testkit/src/index.ts'
import { createOpaqueTokenFormat } from '../packages/token-opaque/src/index.ts'

test('all published compliance suites execute against the reference adapters', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const clock = fixedClock(now)
  const crypto = createNodeCryptoProvider()
  const token = createOpaqueTokenFormat({ crypto })
  const store = createMemoryAuthStore()
  const method = createPasswordMethod({
    passwordHasher: {
      async hashPassword() {
        throw new Error('compliance validation must not hash')
      },
      async verifyPassword() {
        throw new Error('compliance validation must not verify')
      }
    }
  })
  const authResult = createAuth({
    methods: { [method.methodId]: method },
    store,
    token,
    clock,
    idGenerator: deterministicIdGenerator('compliance'),
    session: { defaultTtlSeconds: 3600 }
  })
  assert.equal(authResult.ok, true)
  const outbox = createMemoryOutboxStore()
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(9)),
    keyId: 'compliance-outbox'
  })
  let outboxId = 0
  const effects = createOutboxEffectsDispatcher({
    store: outbox,
    sealer,
    now: () => clock.now(),
    idGenerator: () => `compliance_message_${++outboxId}`
  })
  const deliveries: DeliverySendInput[] = []
  const outboxWorker = createOutboxWorker({
    store: outbox,
    sealer,
    workerId: 'compliance_worker',
    transport: {
      async send(input) {
        deliveries.push(input)
        return { ok: true, value: { acceptedAt: now } }
      }
    }
  })

  const harness = {
    auth: authResult.value,
    method,
    store,
    token,
    carrier: createCookieTokenCarrier(),
    delivery: createSmtpDeliveryTransport({
      now: () => now,
      from: 'no-reply@example.test',
      render: () => ({ subject: 'Compliance', text: 'ok' }),
      client: { sendMail: () => ({ acceptedAt: now }) }
    }),
    effects,
    guard: createMemoryAttemptGuard({ maxFailures: 2, now: () => now }),
    guardFailureThreshold: 2,
    outbox,
    outboxWorker,
    deliveries,
    sealer,
    secretFactory: createSecretFactory(),
    clock
  }

  for (const suite of Object.values(complianceSuites)) {
    await runComplianceSuite(suite, harness)
  }
})
