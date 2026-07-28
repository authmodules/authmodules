import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { createAuth } from '../../../core/src/index.ts'
import {
  createNodeCryptoProvider,
  createNodePasswordHasher,
  createNodeSecretSealer,
  rawSecret
} from '../../../crypto-node/src/index.ts'
import { createSmtpDeliveryTransport } from '../../../delivery-email-smtp/src/index.ts'
import { createOutboxEffectsDispatcher } from '../../../effects-outbox/src/index.ts'
import { createOtpMethod } from '../../../method-otp/src/index.ts'
import { createPasswordMethod } from '../../../method-password/src/index.ts'
import { createOutboxWorker } from '../../../outbox-worker/src/index.ts'
import { createPostgresAuthOutboxStores, installPostgresSchema } from '../../../store-postgres/src/index.ts'
import {
  complianceSuites,
  deterministicIdGenerator,
  fixedClock,
  runComplianceSuite
} from '../../../testkit/src/index.ts'
import { createOpaqueTokenFormat } from '../../../token-opaque/src/index.ts'

const databaseUrl = process.env.AUTHMODULES_POSTGRES_URL

test('password and OTP stacks preserve auth invariants on real PostgreSQL', {
  skip: databaseUrl ? false : 'AUTHMODULES_POSTGRES_URL is not configured'
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const client = postgresClient(pool)
  try {
    await resetSchema(pool)
    await installPostgresSchema(client)
    const stores = createPostgresAuthOutboxStores({ client })
    const store = stores.auth
    const clock = fixedClock(new Date('2026-01-01T00:00:00.000Z'))
    const crypto = createNodeCryptoProvider()
    await runComplianceSuite(complianceSuites.store, { store, clock })

    const password = createPasswordMethod({
      passwordHasher: createNodePasswordHasher({ iterations: 600_000, keyLength: 32 })
    })
    const passwordAuth = configuredAuth({
      clock,
      crypto,
      store,
      methods: { [password.methodId]: password },
      idPrefix: 'pg_password'
    })
    const enrolled = await passwordAuth.enroll({
      context: { tenantId: 'tenant_password', requestId: 'request_enroll' },
      methodId: password.methodId,
      input: {
        subject: ' User@Example.TEST ',
        password: rawSecret('correct horse battery staple')
      },
      account: { mode: 'create-new-account' },
      session: {}
    })
    assert.equal(enrolled.ok, true, JSON.stringify(enrolled))

    const activeSession = await passwordAuth.getSession({
      context: { tenantId: 'tenant_password' },
      token: enrolled.value.token.raw
    })
    const crossTenantSession = await passwordAuth.getSession({
      context: { tenantId: 'tenant_other' },
      token: enrolled.value.token.raw
    })
    assert.equal(activeSession.value.sessionId, enrolled.value.session.sessionId)
    assert.equal(crossTenantSession.value, null)

    const authenticated = await passwordAuth.authenticate({
      context: { tenantId: 'tenant_password', requestId: 'request_authenticate' },
      methodId: password.methodId,
      input: {
        subject: 'user@example.test',
        password: rawSecret('correct horse battery staple')
      },
      session: { ttlSeconds: 120 }
    })
    assert.equal(authenticated.ok, true, JSON.stringify(authenticated))
    assert.equal(authenticated.value.account.accountId, enrolled.value.account.accountId)

    const revoked = await passwordAuth.revokeSession({
      context: {
        tenantId: 'tenant_password',
        actor: { type: 'account', accountId: enrolled.value.account.accountId }
      },
      sessionId: enrolled.value.session.sessionId
    })
    const afterRevoke = await passwordAuth.getSession({
      context: { tenantId: 'tenant_password' },
      token: enrolled.value.token.raw
    })
    assert.equal(revoked.ok, true)
    assert.equal(afterRevoke.value, null)

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
          return { providerMessageId: 'smtp_postgres_1', acceptedAt: clock.now() }
        }
      }
    })
    const otp = createOtpMethod({
      crypto,
      verificationKey: rawSecret(new Uint8Array(32).fill(7)),
      codeLength: 6
    })
    const sealer = createNodeSecretSealer({
      key: rawSecret(new Uint8Array(32).fill(8)),
      keyId: 'postgres-otp-outbox'
    })
    const otpAuth = configuredAuth({
      clock,
      crypto,
      store,
      methods: { [otp.methodId]: otp },
      effects: createOutboxEffectsDispatcher({
        store: stores.outbox,
        sealer,
        now: () => clock.now(),
        idGenerator: () => 'postgres_otp_message'
      }),
      idPrefix: 'pg_otp'
    })
    const begun = await otpAuth.begin({
      context: { tenantId: 'tenant_otp', locale: 'en' },
      methodId: otp.methodId,
      input: {
        subject: ' Otp@Example.TEST ',
        display: 'attacker@example.test',
        deliveryTarget: 'attacker@example.test'
      },
      account: { mode: 'create-account-if-identity-missing' },
      session: {}
    })
    assert.equal(begun.ok, true, JSON.stringify(begun))
    assert.equal(deliveredCode, undefined)
    const delivery = await createOutboxWorker({
      store: stores.outbox,
      transport,
      sealer,
      workerId: 'postgres_otp_worker'
    }).runOnce({ now: clock.now() })
    assert.equal(delivery.ok, true)
    assert.equal(delivery.value.dispatched, 1)
    assert.equal(deliveredTo, 'otp@example.test')
    assert.equal(typeof deliveredCode, 'string')

    const complete = () => otpAuth.complete({
      context: { tenantId: 'tenant_otp', locale: 'en' },
      challengeId: begun.value.challengeId,
      input: { code: rawSecret(deliveredCode) }
    })
    const concurrent = await Promise.all([complete(), complete()])
    assert.equal(concurrent.filter((result) => result.ok).length, 1)
    const failure = concurrent.find((result) => !result.ok)
    assert.equal(['CHALLENGE_ALREADY_CONSUMED', 'CHALLENGE_VERSION_CONFLICT'].includes(failure.error.internalReason), true)
  } finally {
    await pool.end()
  }
})

function configuredAuth({ clock, crypto, store, methods, effects, idPrefix }) {
  const result = createAuth({
    clock,
    idGenerator: deterministicIdGenerator(idPrefix),
    store,
    methods,
    effects,
    token: createOpaqueTokenFormat({ crypto }),
    session: { defaultTtlSeconds: 3600, maxTtlSeconds: 7200 }
  })
  assert.equal(result.ok, true)
  return result.value
}

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
