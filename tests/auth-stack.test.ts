import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuth } from '../../core/src/index.ts'
import {
  createNodeCryptoProvider,
  createNodePasswordHasher,
  createNodeSecretSealer,
  rawSecret
} from '../../crypto-node/src/index.ts'
import { createSmtpDeliveryTransport } from '../../delivery-email-smtp/src/index.ts'
import { createOutboxEffectsDispatcher } from '../../effects-outbox/src/index.ts'
import { createOtpMethod } from '../../method-otp/src/index.ts'
import { createPasswordMethod } from '../../method-password/src/index.ts'
import { createOutboxWorker } from '../../outbox-worker/src/index.ts'
import {
  createMemoryAuthOutboxStores,
  createMemoryAuthStore,
  deterministicIdGenerator,
  fixedClock
} from '../../testkit/src/index.ts'
import { createOpaqueTokenFormat } from '../../token-opaque/src/index.ts'

test('password stack enrolls, authenticates, creates sessions, and preserves tenant isolation', async () => {
  const clock = fixedClock(new Date('2026-01-01T00:00:00.000Z'))
  const crypto = createNodeCryptoProvider()
  const store = createMemoryAuthStore()
  const method = createPasswordMethod({
    passwordHasher: createNodePasswordHasher({ iterations: 600_000, keyLength: 32 })
  })
  const auth = configuredAuth({ clock, crypto, store, methods: { [method.methodId]: method } })

  const enrolled = await auth.enroll({
    context: { tenantId: 'tenant_a', requestId: 'request_enroll' },
    methodId: method.methodId,
    input: {
      subject: ' User@Example.TEST ',
      password: rawSecret('correct horse battery staple')
    },
    account: { mode: 'create-new-account' },
    session: {}
  })

  assert.equal(enrolled.ok, true)
  assert.equal(enrolled.value.identity.subject, 'user@example.test')
  assert.equal(enrolled.value.identity.verifiedAt, undefined)
  assert.equal(enrolled.value.session.status, 'active')
  assert.equal(typeof enrolled.value.token.raw.reveal(), 'string')
  assert.equal(JSON.stringify(enrolled.value).includes('correct horse battery staple'), false)

  const authenticated = await auth.authenticate({
    context: { tenantId: 'tenant_a', requestId: 'request_authenticate' },
    methodId: method.methodId,
    input: {
      subject: 'user@example.test',
      password: rawSecret('correct horse battery staple')
    },
    session: { ttlSeconds: 120 }
  })
  assert.equal(authenticated.ok, true)
  assert.equal(authenticated.value.account.accountId, enrolled.value.account.accountId)

  const crossTenant = await auth.authenticate({
    context: { tenantId: 'tenant_b' },
    methodId: method.methodId,
    input: {
      subject: 'user@example.test',
      password: rawSecret('correct horse battery staple')
    }
  })
  assert.equal(crossTenant.ok, false)
  assert.equal(crossTenant.error.publicError.code, 'AUTHENTICATION_FAILED')
})

test('OTP stack binds delivery to the canonical subject and verifies the stored challenge', async () => {
  const clock = fixedClock(new Date('2026-01-01T00:00:00.000Z'))
  const crypto = createNodeCryptoProvider()
  const stores = createMemoryAuthOutboxStores()
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(6)),
    keyId: 'stack-otp-outbox'
  })
  let deliveredCode
  let deliveredTo
  const transport = createSmtpDeliveryTransport({
    now: () => clock.now(),
    from: 'no-reply@example.test',
    render(input) {
      return {
        subject: 'Your sign-in code',
        text: `Code: ${input.message.data.code.reveal()}`
      }
    },
    client: {
      async sendMail(input) {
        deliveredTo = input.to
        deliveredCode = input.text.slice('Code: '.length)
        return { providerMessageId: 'smtp_1', acceptedAt: clock.now() }
      }
    }
  })
  const method = createOtpMethod({
    crypto,
    verificationKey: rawSecret(new Uint8Array(32).fill(5)),
    codeLength: 6
  })
  const auth = configuredAuth({
    clock,
    crypto,
    store: stores.auth,
    methods: { [method.methodId]: method },
    effects: createOutboxEffectsDispatcher({
      store: stores.outbox,
      sealer,
      now: () => clock.now(),
      idGenerator: () => 'stack_otp_message'
    })
  })

  const begun = await auth.begin({
    context: { tenantId: 'tenant_a', locale: 'en' },
    methodId: method.methodId,
    input: {
      subject: ' User@Example.TEST ',
      display: 'attacker@example.test',
      deliveryTarget: 'attacker@example.test'
    },
    account: { mode: 'create-account-if-identity-missing' },
    session: {}
  })
  assert.equal(begun.ok, true)
  assert.equal(deliveredCode, undefined)
  const delivery = await createOutboxWorker({
    store: stores.outbox,
    transport,
    sealer,
    workerId: 'stack_otp_worker'
  }).runOnce({ now: clock.now() })
  assert.equal(delivery.ok, true)
  assert.equal(delivery.value.dispatched, 1, JSON.stringify(delivery))
  assert.equal(deliveredTo, 'user@example.test')
  assert.equal(typeof deliveredCode, 'string')

  const completed = await auth.complete({
    context: { tenantId: 'tenant_a', locale: 'en' },
    challengeId: begun.value.challengeId,
    input: { code: rawSecret(deliveredCode) }
  })
  assert.equal(completed.ok, true, JSON.stringify(completed))
  assert.equal(completed.value.proof.primaryIdentity.subject, 'user@example.test')
  assert.equal(completed.value.proof.primaryIdentity.verifiedAt.toISOString(), clock.now().toISOString())
  assert.equal(completed.value.session.status, 'active')

  const replayed = await auth.complete({
    context: { tenantId: 'tenant_a' },
    challengeId: begun.value.challengeId,
    input: { code: rawSecret(deliveredCode) }
  })
  assert.equal(replayed.ok, false)
  assert.equal(replayed.error.internalReason, 'CHALLENGE_ALREADY_CONSUMED')
})

function configuredAuth({ clock, crypto, store, methods, effects }) {
  const result = createAuth({
    clock,
    idGenerator: deterministicIdGenerator('stack'),
    store,
    methods,
    effects,
    token: createOpaqueTokenFormat({ crypto }),
    session: { defaultTtlSeconds: 3600, maxTtlSeconds: 7200 }
  })
  assert.equal(result.ok, true)
  return result.value
}
