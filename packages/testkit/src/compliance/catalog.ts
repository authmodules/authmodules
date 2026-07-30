import { type ComplianceHarness, type ComplianceSuiteCatalog } from './types.ts'
import { complianceAssert, requireHarness } from './assertions.ts'
import { createComplianceSuite } from './run.ts'

export const complianceSuites: ComplianceSuiteCatalog = {
  boundary: createComplianceSuite('boundary', [{
    name: 'core and carrier remain separate composition ports',
    run(harness: ComplianceHarness): void {
      const auth = requireHarness(harness.auth, 'auth')
      requireHarness(harness.carrier, 'carrier')
      complianceAssert(!('carrier' in auth), 'Auth runtime must not expose a carrier dependency')
    }
  }, {
    name: 'auth exposes only operation methods',
    run(harness: ComplianceHarness): void {
      const auth = requireHarness(harness.auth, 'auth')
      for (const operation of ['enroll', 'authenticate', 'begin', 'complete', 'getSession', 'revokeSession'] as const) {
        complianceAssert(typeof auth[operation] === 'function', `Auth is missing ${operation}`)
      }
      for (const collaborator of ['store', 'token', 'effects', 'eventSink', 'guard', 'policy']) {
        complianceAssert(!(collaborator in auth), `Auth leaks ${collaborator}`)
      }
    }
  }]),
  coreFlows: createComplianceSuite('core-flows', [{
    name: 'missing session token is an anonymous success',
    async run(harness: ComplianceHarness): Promise<void> {
      const auth = requireHarness(harness.auth, 'auth')
      const result = await auth.getSession({ context: { tenantId: 'compliance_tenant' } })
      complianceAssert(result.ok && result.value === null, 'getSession without a token must return ok(null)')
    }
  }, {
    name: 'malformed public input is a typed auth failure',
    async run(harness: ComplianceHarness): Promise<void> {
      const auth = requireHarness(harness.auth, 'auth')
      const getSession = auth.getSession as (input: unknown) => ReturnType<typeof auth.getSession>
      const result = await getSession(undefined)
      complianceAssert(
        result?.ok === false && result.error?.type === 'auth.failure' && result.error.publicError?.code === 'INVALID_INPUT',
        'Malformed auth input must return INVALID_INPUT'
      )
    }
  }]),
  method: createComplianceSuite('method', [{
    name: 'method identifiers are stable and operations are explicit',
    run(harness: ComplianceHarness): void {
      const method = requireHarness(harness.method, 'method')
      complianceAssert(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(method.methodId), 'Method id is not stable')
      complianceAssert(Object.keys(method.operations).length > 0, 'Method must expose at least one operation')
    }
  }, {
    name: 'method operations reject missing input during validation',
    run(harness: ComplianceHarness): void {
      const method = requireHarness(harness.method, 'method')
      for (const [name, operation] of Object.entries(method.operations)) {
        if (!operation) continue
        const result = operation.validate(undefined, {
          method: { methodId: method.methodId, methodKind: method.methodKind },
          auth: { tenantId: 'compliance_tenant' },
          now: new Date('2026-01-01T00:00:00.000Z')
        })
        complianceAssert(result?.ok === false && result.error?.type === 'validation.failure', `${name} accepted missing input`)
      }
    }
  }]),
  store: createComplianceSuite('store', [{
    name: 'account lookups are tenant isolated',
    async run(harness: ComplianceHarness): Promise<void> {
      const store = requireHarness(harness.store, 'store')
      const now = harness.clock?.now() ?? new Date('2026-01-01T00:00:00.000Z')
      const record = {
        tenantId: 'compliance_tenant_a',
        accountId: 'compliance_account',
        status: 'active' as const,
        createdAt: now,
        updatedAt: now
      }
      const created = await store.durable.accounts.create({ record })
      complianceAssert(created.ok, 'Account fixture could not be created')
      const isolated = await store.durable.accounts.findById({
        tenantId: 'compliance_tenant_b',
        accountId: record.accountId
      })
      complianceAssert(isolated.ok && isolated.value === null, 'Account lookup crossed a tenant boundary')
    }
  }, {
    name: 'missing account status update is a typed store failure',
    async run(harness: ComplianceHarness): Promise<void> {
      const store = requireHarness(harness.store, 'store')
      const result = await store.durable.accounts.updateStatus({
        tenantId: 'compliance_tenant',
        accountId: 'compliance_missing_account',
        status: 'disabled',
        now: harness.clock?.now() ?? new Date('2026-01-01T00:00:00.000Z')
      })
      complianceAssert(result?.ok === false && result.error?.component === 'store', 'Missing update must return StoreFailure')
    }
  }, {
    name: 'store rejects secret descriptors in public and nested private data',
    async run(harness: ComplianceHarness): Promise<void> {
      const store = requireHarness(harness.store, 'store')
      const now = harness.clock?.now() ?? new Date('2026-01-01T00:00:00.000Z')
      const createAccount = store.durable.accounts.create as (input: unknown) => ReturnType<typeof store.durable.accounts.create>
      const createIdentity = store.durable.identities.create as (input: unknown) => ReturnType<typeof store.durable.identities.create>
      const createCredential = store.durable.credentials.create as (input: unknown) => ReturnType<typeof store.durable.credentials.create>
      const account = await createAccount({
        record: {
          tenantId: 'compliance_tenant',
          accountId: 'compliance_secret_account',
          status: 'active',
          publicData: {
            verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
          },
          createdAt: now,
          updatedAt: now
        }
      })
      complianceAssert(!account.ok && account.error.component === 'store', 'Store accepted a public secret descriptor')
      const parentAccount = await createAccount({
        record: {
          tenantId: 'compliance_tenant',
          accountId: 'compliance_secret_parent_account',
          status: 'active',
          createdAt: now,
          updatedAt: now
        }
      })
      complianceAssert(parentAccount.ok, 'Unable to create valid parent account for nested secret test')
      const parentIdentity = await createIdentity({
        record: {
          tenantId: 'compliance_tenant',
          identityId: 'compliance_secret_parent_identity',
          accountId: 'compliance_secret_parent_account',
          methodId: 'password.email',
          methodKind: 'password',
          subject: 'compliance-secret@example.test',
          subjectKind: 'email',
          createdAt: now,
          updatedAt: now
        }
      })
      complianceAssert(parentIdentity.ok, 'Unable to create valid parent identity for nested secret test')
      const credential = await createCredential({
        record: {
          tenantId: 'compliance_tenant',
          credentialId: 'compliance_secret_credential',
          accountId: 'compliance_secret_parent_account',
          identityId: 'compliance_secret_parent_identity',
          methodId: 'password.email',
          methodKind: 'password',
          status: 'active',
          material: {
            schemaVersion: 'password.v1',
            privateData: {
              nested: {
                verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
              }
            }
          },
          version: 1,
          createdAt: now,
          updatedAt: now
        }
      })
      complianceAssert(!credential.ok && credential.error.component === 'store', 'Store accepted nested private secret data')
    }
  }, {
    name: 'store transaction covers core scopes and rolls back failed results',
    async run(harness: ComplianceHarness): Promise<void> {
      const store = requireHarness(harness.store, 'store')
      const transaction = requireHarness(store.transaction, 'store.transaction')
      const now = harness.clock?.now() ?? new Date('2026-01-01T00:00:00.000Z')
      const tenantId = 'compliance_transaction_tenant'
      const accountId = 'compliance_transaction_account'
      const requiredScopes = ['accounts', 'identities', 'credentials', 'sessions', 'challenges'] as const
      const result = await transaction.run({ requiredScopes }, async (tx) => {
        for (const scope of requiredScopes) {
          complianceAssert(tx.covers.includes(scope), `Transaction does not cover ${scope}`)
        }
        const created = await store.durable.accounts.create({
          record: {
            tenantId,
            accountId,
            status: 'active',
            createdAt: now,
            updatedAt: now
          }
        }, tx)
        complianceAssert(created.ok, 'Transaction fixture could not be created')
        return {
          ok: false as const,
          error: {
            type: 'component.failure' as const,
            component: 'transaction' as const,
            reason: 'TRANSACTION_FAILED'
          }
        }
      })
      complianceAssert(!result.ok, 'Failed transaction unexpectedly succeeded')
      const persisted = await store.durable.accounts.findById({ tenantId, accountId })
      complianceAssert(persisted.ok && persisted.value === null, 'Failed transaction did not roll back account creation')
    }
  }]),
  token: createComplianceSuite('token', [{
    name: 'issued token separates raw and protected values',
    async run(harness: ComplianceHarness): Promise<void> {
      const token = requireHarness(harness.token, 'token')
      const now = harness.clock?.now() ?? new Date('2026-01-01T00:00:00.000Z')
      const issued = await token.issue({
        tenantId: 'compliance_tenant',
        accountId: 'compliance_account',
        sessionId: 'compliance_session',
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60000)
      })
      complianceAssert(issued.ok, 'Token issue failed')
      complianceAssert(typeof issued.value.raw.reveal === 'function', 'Issued token raw value is not wrapped')
      complianceAssert(typeof issued.value.tokenHash.revealForPersistence === 'function', 'Token hash is not protected')
    }
  }, {
    name: 'issued raw token redacts during serialization',
    async run(harness: ComplianceHarness): Promise<void> {
      const token = requireHarness(harness.token, 'token')
      const now = harness.clock?.now() ?? new Date('2026-01-01T00:00:00.000Z')
      const issued = await token.issue({
        tenantId: 'compliance_tenant',
        accountId: 'compliance_account',
        sessionId: 'compliance_session_redaction',
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60000)
      })
      complianceAssert(issued.ok, 'Token issue failed')
      const revealed = issued.value.raw.reveal()
      complianceAssert(!JSON.stringify(issued.value.raw).includes(String(revealed)), 'Raw token leaked during serialization')
    }
  }]),
  carrier: createComplianceSuite('carrier', [{
    name: 'missing carrier token is non-failing',
    run(harness: ComplianceHarness): void {
      const carrier = requireHarness(harness.carrier, 'carrier')
      const result = carrier.read({ headers: {} })
      complianceAssert(result.ok && !result.value.found, 'Missing carrier token must return found=false')
    }
  }, {
    name: 'malformed carrier input is a typed failure',
    run(harness: ComplianceHarness): void {
      const carrier = requireHarness(harness.carrier, 'carrier')
      const read = carrier.read as (input: unknown) => ReturnType<typeof carrier.read>
      const result = read(undefined)
      complianceAssert(result?.ok === false && result.error?.component === 'carrier', 'Malformed carrier input must fail')
    }
  }]),
  deliveryEffects: createComplianceSuite('delivery-effects', [{
    name: 'delivery transport accepts template-first messages',
    async run(harness: ComplianceHarness): Promise<void> {
      const delivery = requireHarness(harness.delivery, 'delivery')
      const now = harness.clock?.now() ?? new Date('2026-01-01T00:00:00.000Z')
      const result = await delivery.send({
        context: { tenantId: 'compliance_tenant' },
        message: {
          to: { channel: 'email', target: 'user@example.test' },
          templateId: 'compliance.message'
        },
        now
      })
      complianceAssert(result.ok, 'Template-first delivery failed')
      complianceAssert(result.value.acceptedAt instanceof Date && !Number.isNaN(result.value.acceptedAt.getTime()), 'Delivery acceptedAt is invalid')
    }
  }]),
  security: createComplianceSuite('security', [{
    name: 'raw secrets redact during serialization',
    run(harness: ComplianceHarness): void {
      const factory = requireHarness(harness.secretFactory, 'secretFactory')
      const raw = factory.raw('compliance_secret')
      complianceAssert(!JSON.stringify(raw).includes('compliance_secret'), 'Raw secret leaked during serialization')
    }
  }, {
    name: 'protected and sealed secrets expose only explicit persistence boundaries',
    run(harness: ComplianceHarness): void {
      const factory = requireHarness(harness.secretFactory, 'secretFactory')
      const now = new Date('2026-01-01T00:00:00.000Z')
      const protectedSecret = factory.protectedValue({ type: 'protected-value', scheme: 'compliance.v1', value: 'protected', createdAt: now })
      const sealedSecret = factory.sealedValue({ type: 'sealed-secret', algorithm: 'compliance.v1', keyId: 'test', ciphertext: 'sealed' })
      complianceAssert(typeof protectedSecret.revealForPersistence === 'function' && !('reveal' in protectedSecret), 'Protected secret boundary is invalid')
      complianceAssert(typeof sealedSecret.revealCiphertextForPersistence === 'function' && !('reveal' in sealedSecret), 'Sealed secret boundary is invalid')
    }
  }]),
  guardOutboxProfile: createComplianceSuite('guard-outbox-profile', [{
    name: 'guard and outbox expose lease-aware production ports',
    run(harness: ComplianceHarness): void {
      const guard = requireHarness(harness.guard, 'guard')
      const outbox = requireHarness(harness.outbox, 'outbox')
      complianceAssert(typeof guard.beforeAttempt === 'function' && typeof guard.afterAttempt === 'function', 'Guard port is incomplete')
      complianceAssert(
        typeof outbox.claimBatch === 'function'
        && typeof outbox.markDispatched === 'function'
        && typeof outbox.markFailed === 'function',
        'Outbox lease port is incomplete'
      )
    }
  }, {
    name: 'guard and outbox reject malformed boundary input',
    async run(harness: ComplianceHarness): Promise<void> {
      const guard = requireHarness(harness.guard, 'guard')
      const outbox = requireHarness(harness.outbox, 'outbox')
      const beforeAttempt = guard.beforeAttempt as (input: unknown) => ReturnType<typeof guard.beforeAttempt>
      const claimBatch = outbox.claimBatch as (input: unknown) => ReturnType<typeof outbox.claimBatch>
      const guarded = await beforeAttempt(undefined)
      const claimed = await claimBatch(undefined)
      complianceAssert(guarded?.ok === false && guarded.error?.component === 'guard', 'Malformed guard input must fail')
      complianceAssert(claimed?.ok === false && claimed.error?.component === 'store', 'Malformed outbox claim must fail')
    }
  }, {
    name: 'guard counts authentication failures but ignores infrastructure failures',
    async run(harness: ComplianceHarness): Promise<void> {
      const guard = requireHarness(harness.guard, 'guard')
      const threshold = requireHarness(harness.guardFailureThreshold, 'guardFailureThreshold')
      const attempt = complianceAttempt('guard_semantics')

      const infrastructure = await guard.afterAttempt({
        ...attempt,
        outcome: { success: false, reason: 'STORE_UNAVAILABLE', countsAsAttempt: false }
      })
      const allowedAfterInfrastructure = await guard.beforeAttempt(attempt)
      complianceAssert(infrastructure.ok, 'Guard rejected infrastructure bookkeeping')
      complianceAssert(
        allowedAfterInfrastructure.ok && allowedAfterInfrastructure.value.allow,
        'Infrastructure failures must not consume authentication attempts'
      )

      for (let index = 0; index < threshold; index += 1) {
        const recorded = await guard.afterAttempt({
          ...attempt,
          outcome: { success: false, reason: 'compliance.invalid-proof', countsAsAttempt: true }
        })
        complianceAssert(recorded.ok, 'Guard could not record an authentication failure')
      }
      const denied = await guard.beforeAttempt(attempt)
      complianceAssert(
        denied.ok && !denied.value.allow,
        'Configured authentication failure threshold must deny the next attempt'
      )

      const reset = await guard.afterAttempt({ ...attempt, outcome: { success: true } })
      const allowedAfterSuccess = await guard.beforeAttempt(attempt)
      complianceAssert(reset.ok, 'Guard could not record a successful attempt')
      complianceAssert(
        allowedAfterSuccess.ok && allowedAfterSuccess.value.allow,
        'Successful authentication must clear the matching failure window'
      )
    }
  }, {
    name: 'outbox leases are tenant and worker scoped and idempotency is stable',
    async run(harness: ComplianceHarness): Promise<void> {
      const outbox = requireHarness(harness.outbox, 'outbox')
      const now = harness.clock?.now() ?? new Date('2026-01-01T00:00:00.000Z')
      const firstMessage = complianceOutboxMessage('lease_tenant', 'lease_message', now, 'lease_idempotency')
      const enqueued = await outbox.enqueue({ message: firstMessage })
      const duplicate = await outbox.enqueue({
        message: {
          ...firstMessage,
          messageId: 'lease_duplicate',
          secretPurpose: JSON.stringify([
            'authmodules.outbox.delivery',
            firstMessage.tenantId,
            'lease_duplicate'
          ])
        }
      })
      complianceAssert(enqueued.ok, 'Outbox fixture could not be enqueued')
      complianceAssert(
        duplicate.ok && duplicate.value.messageId === firstMessage.messageId,
        'Outbox idempotency key must return the original message'
      )

      const otherTenant = await outbox.claimBatch({
        tenantId: 'other_tenant',
        now,
        limit: 1,
        workerId: 'lease_worker',
        leaseSeconds: 30
      })
      complianceAssert(otherTenant.ok && otherTenant.value.length === 0, 'Outbox claim crossed tenant boundary')

      const claimed = await outbox.claimBatch({
        tenantId: firstMessage.tenantId,
        now,
        limit: 1,
        workerId: 'lease_worker',
        leaseSeconds: 30
      })
      complianceAssert(claimed.ok && claimed.value.length === 1, 'Outbox message was not leased')
      const leased = claimed.value[0]
      const wrongWorker = await outbox.markDispatched({
        tenantId: leased.tenantId,
        messageId: leased.messageId,
        workerId: 'other_worker',
        leaseId: leased.lease.leaseId,
        now
      })
      const wrongTenant = await outbox.markDispatched({
        tenantId: 'other_tenant',
        messageId: leased.messageId,
        workerId: leased.lease.workerId,
        leaseId: leased.lease.leaseId,
        now
      })
      complianceAssert(!wrongWorker.ok && !wrongTenant.ok, 'Outbox lease mutation ignored tenant or worker ownership')

      const marked = await outbox.markDispatched({
        tenantId: leased.tenantId,
        messageId: leased.messageId,
        workerId: leased.lease.workerId,
        leaseId: leased.lease.leaseId,
        now
      })
      complianceAssert(marked.ok, 'Matching outbox lease could not be completed')
    }
  }, {
    name: 'official outbox pipeline seals secrets and preserves delivery idempotency',
    async run(harness: ComplianceHarness): Promise<void> {
      const effects = requireHarness(harness.effects, 'effects')
      const worker = requireHarness(harness.outboxWorker, 'outboxWorker')
      const deliveries = requireHarness(harness.deliveries, 'deliveries')
      const secretFactory = requireHarness(harness.secretFactory, 'secretFactory')
      const now = harness.clock?.now() ?? new Date('2026-01-01T00:00:00.000Z')
      const deliveryCount = deliveries.length
      const dispatched = await effects.dispatch({
        context: { tenantId: 'pipeline_tenant' },
        now,
        effects: [{
          type: 'delivery',
          dispatchPolicy: 'required',
          idempotencyKey: 'pipeline_idempotency',
          message: {
            to: { channel: 'email', target: 'user@example.test' },
            templateId: 'otp',
            data: { code: secretFactory.raw('123456') }
          }
        }]
      })
      complianceAssert(dispatched.ok, 'Outbox dispatcher rejected a valid delivery effect')

      const processed = await worker.runOnce({ tenantId: 'pipeline_tenant', now })
      complianceAssert(
        processed.ok && processed.value.claimed === 1 && processed.value.dispatched === 1,
        'Outbox worker did not deliver the dispatched effect'
      )
      complianceAssert(deliveries.length === deliveryCount + 1, 'Outbox worker did not call delivery transport exactly once')
      const delivered = deliveries[deliveryCount]
      complianceAssert(delivered.idempotencyKey === 'pipeline_idempotency', 'Delivery idempotency key changed in the outbox pipeline')
      complianceAssert(
        isRecord(delivered.message.data)
          && revealString(delivered.message.data.code) === '123456',
        'Outbox worker did not restore the sealed delivery secret'
      )
    }
  }])
}

function complianceAttempt(subject: string) {
  return {
    context: { tenantId: 'compliance_guard' },
    method: { methodId: 'authmodules.password', methodKind: 'password' },
    operation: 'authenticate' as const,
    lookup: {
      methodId: 'authmodules.password',
      methodKind: 'password',
      subject,
      subjectKind: 'email'
    }
  }
}

function complianceOutboxMessage(tenantId: string, messageId: string, now: Date, idempotencyKey: string) {
  return {
    tenantId,
    messageId,
    context: { tenantId },
    secretPurpose: JSON.stringify(['authmodules.outbox.delivery', tenantId, messageId]),
    type: 'delivery' as const,
    message: { to: { channel: 'email' as const, target: 'user@example.test' }, templateId: 'compliance' },
    dispatchPolicy: 'required' as const,
    status: 'pending' as const,
    attempts: 0,
    maxAttempts: 3,
    idempotencyKey,
    availableAt: now,
    createdAt: now,
    updatedAt: now
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function revealString(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.reveal !== 'function') return undefined
  const revealed = value.reveal()
  return typeof revealed === 'string' ? revealed : undefined
}
