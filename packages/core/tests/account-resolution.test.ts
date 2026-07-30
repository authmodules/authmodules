import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createIdentityForClaim,
  findIdentity,
  identityKeyForProof,
  resolveAccount
} from '../src/accounts/resolve.ts'
import {
  challengeRecordFailedAttemptReason,
  challengeResultToReason
} from '../src/operations/challenge/result.ts'
import { proofMatches } from '../src/method/proof.ts'
import { invokeMethodValidation } from '../src/method/invoke.ts'
import { authErr, catchBoundary, mapReason, storeFailure } from '../src/shared/errors.ts'

const now = new Date('2026-01-01T00:00:00.000Z')
const context = { tenantId: 'tenant_1' }
const identityClaim = {
  methodId: 'password.email',
  methodKind: 'password',
  subject: 'user@example.test',
  subjectKind: 'email',
  verifiedAt: now
}
const identityRecord = {
  ...identityClaim,
  tenantId: context.tenantId,
  identityId: 'identity_1',
  accountId: 'account_1',
  createdAt: now,
  updatedAt: now
}
const accountRecord = {
  tenantId: context.tenantId,
  accountId: 'account_1',
  status: 'active',
  createdAt: now,
  updatedAt: now
}

test('method validation snapshots lookup and public data before async work', async () => {
  const lookup = {
    methodId: 'password.email',
    methodKind: 'password',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const publicData = { flow: 'login' }
  const result = invokeMethodValidation(() => {
    queueMicrotask(() => {
      lookup.subject = 'attacker@example.test'
      publicData.flow = 'mutated'
    })
    return {
      ok: true,
      value: {
        value: { password: 'method-owned' },
        lookup,
        publicData
      }
    }
  }, {}, {
    method: { methodId: 'password.email', methodKind: 'password' },
    auth: context,
    now
  })
  await Promise.resolve()

  assert.equal(result.ok, true)
  assert.equal(result.value.lookup.subject, 'user@example.test')
  assert.deepEqual(result.value.publicData, { flow: 'login' })
})

test('account resolution enforces identity and actor ownership modes', async () => {
  const denied = await resolveAccount(
    { ...config(), policy: () => ({ allow: false, reason: 'ACCOUNT_RESOLUTION_DENIED' }) },
    context,
    { mode: 'create-new-account' },
    identityClaim,
    undefined,
    now
  )
  const createConflict = await resolveAccount(
    config({ identity: identityRecord }),
    context,
    { mode: 'create-new-account' },
    identityClaim,
    undefined,
    now
  )
  const requiredMissing = await resolveAccount(
    config(),
    context,
    { mode: 'require-existing-identity' },
    identityClaim,
    undefined,
    now
  )
  const anonymousLink = await resolveAccount(
    config(),
    context,
    { mode: 'link-to-actor-account' },
    identityClaim,
    undefined,
    now
  )
  const foreignLink = await resolveAccount(
    config({ identity: { ...identityRecord, accountId: 'account_2' } }),
    { ...context, actor: { type: 'account', accountId: 'account_1' } },
    { mode: 'link-to-actor-account' },
    identityClaim,
    undefined,
    now
  )

  assert.equal(denied.error.internalReason, 'ACCOUNT_RESOLUTION_DENIED')
  assert.equal(createConflict.error.internalReason, 'IDENTITY_CONFLICT')
  assert.equal(requiredMissing.error.internalReason, 'AUTHENTICATION_FAILED')
  assert.equal(anonymousLink.error.internalReason, 'ACCOUNT_LINKING_DENIED')
  assert.equal(foreignLink.error.internalReason, 'ACCOUNT_LINKING_DENIED')
})

test('account resolution returns actor, existing, and newly created accounts', async () => {
  const actor = { ...context, actor: { type: 'account', accountId: 'account_1' } }
  const linked = await resolveAccount(
    config({ identity: identityRecord, account: accountRecord }),
    actor,
    { mode: 'link-to-actor-account' },
    identityClaim,
    undefined,
    now
  )
  const existing = await resolveAccount(
    config({ identity: identityRecord, account: accountRecord }),
    context,
    { mode: 'create-account-if-identity-missing' },
    identityClaim,
    undefined,
    now
  )
  const created = await resolveAccount(
    config(),
    context,
    { mode: 'create-account-if-identity-missing' },
    identityClaim,
    undefined,
    now
  )

  assert.equal(linked.value.account.accountId, 'account_1')
  assert.equal(linked.value.identity.identityId, 'identity_1')
  assert.equal(existing.value.account.accountId, 'account_1')
  assert.equal(existing.value.identity.identityId, 'identity_1')
  assert.equal(created.value.account.accountId, 'account_generated')
  assert.equal(created.value.identity, undefined)
})

test('account resolution maps store failures and unavailable actor accounts', async () => {
  const identityFailure = await resolveAccount(
    config({ identityFailure: true }),
    context,
    { mode: 'create-account-if-identity-missing' },
    identityClaim,
    undefined,
    now
  )
  const accountFailure = await resolveAccount(
    config({ identity: identityRecord, accountFailure: true }),
    context,
    { mode: 'create-account-if-identity-missing' },
    identityClaim,
    undefined,
    now
  )
  const createFailure = await resolveAccount(
    config({ createFailure: true }),
    context,
    { mode: 'create-account-if-identity-missing' },
    identityClaim,
    undefined,
    now
  )
  const missingActor = await resolveAccount(
    config(),
    { ...context, actor: { type: 'account', accountId: 'account_1' } },
    { mode: 'link-to-actor-account' },
    identityClaim,
    undefined,
    now
  )

  assert.equal(identityFailure.error.internalReason, 'STORE_UNAVAILABLE')
  assert.equal(accountFailure.error.internalReason, 'STORE_UNAVAILABLE')
  assert.equal(createFailure.error.internalReason, 'STORE_UNAVAILABLE')
  assert.equal(missingActor.error.internalReason, 'ACCOUNT_UNAVAILABLE')
})

test('account resolution rejects store records outside the requested tenant scope', async () => {
  const foreignIdentity = await resolveAccount(
    config({ identity: { ...identityRecord, tenantId: 'tenant_other' } }),
    context,
    { mode: 'create-account-if-identity-missing' },
    identityClaim,
    undefined,
    now
  )
  const foreignAccount = await resolveAccount(
    config({
      identity: identityRecord,
      account: { ...accountRecord, tenantId: 'tenant_other' }
    }),
    context,
    { mode: 'create-account-if-identity-missing' },
    identityClaim,
    undefined,
    now
  )

  assert.equal(foreignIdentity.error.internalReason, 'INTERNAL')
  assert.equal(foreignIdentity.error.publicError.code, 'TEMPORARILY_UNAVAILABLE')
  assert.equal(foreignAccount.error.internalReason, 'INTERNAL')
  assert.equal(foreignAccount.error.publicError.code, 'TEMPORARILY_UNAVAILABLE')
})

test('account resolution rejects invalid generated identifiers before persistence', async () => {
  let accountCreates = 0
  let identityCreates = 0
  const invalidAccount = await resolveAccount(
    config({
      generate() {
        return ''
      },
      accountCreated() {
        accountCreates += 1
      }
    }),
    context,
    { mode: 'create-account-if-identity-missing' },
    identityClaim,
    undefined,
    now
  )
  const throwingAccount = await resolveAccount(
    config({
      generate() {
        throw new Error('private generator failure')
      }
    }),
    context,
    { mode: 'create-account-if-identity-missing' },
    identityClaim,
    undefined,
    now
  )
  const invalidIdentity = await createIdentityForClaim(
    config({
      generate() {
        return 'identity\ninvalid'
      },
      identityCreated() {
        identityCreates += 1
      }
    }),
    context,
    'account_1',
    identityClaim,
    now
  )

  assert.equal(invalidAccount.error.internalReason, 'INTERNAL')
  assert.equal(throwingAccount.error.internalReason, 'INTERNAL')
  assert.equal(invalidIdentity.error.internalReason, 'INTERNAL')
  assert.equal(accountCreates, 0)
  assert.equal(identityCreates, 0)
})

test('identity creation preserves claim binding and maps store failures', async () => {
  const missingLookup = await findIdentity(config(), context, undefined)
  const created = await createIdentityForClaim(
    config(),
    context,
    'account_1',
    identityClaim,
    now
  )
  const failed = await createIdentityForClaim(
    config({ identityCreateFailure: true }),
    context,
    'account_1',
    identityClaim,
    now
  )

  assert.equal(missingLookup.value, null)
  assert.equal(created.value.identityId, 'identity_generated')
  assert.equal(created.value.subject, identityClaim.subject)
  assert.equal(failed.error.internalReason, 'STORE_UNAVAILABLE')
  assert.equal(
    identityKeyForProof(identityClaim),
    'password.email\u0000user@example.test'
  )
})

test('proof identity uniqueness matches the persisted method and subject key', () => {
  const method = { methodId: identityClaim.methodId, methodKind: identityClaim.methodKind }
  const proof = {
    type: 'auth.proof',
    proofMethod: method,
    primaryIdentity: identityClaim,
    additionalIdentities: [{
      ...identityClaim,
      methodKind: 'other-kind',
      subjectKind: 'username'
    }],
    evidence: [],
    authTime: now
  }

  assert.equal(proofMatches(method, undefined, proof, now), false)
})

test('stable error and challenge mappings cover every public outcome family', async () => {
  const mappings = new Map([
    ['VALIDATION_FAILED', 'INVALID_INPUT'],
    ['SESSION_TTL_INVALID', 'INVALID_INPUT'],
    ['IDENTITY_CONFLICT', 'CONFLICT'],
    ['CREDENTIAL_CONFLICT', 'CONFLICT'],
    ['ACCOUNT_DISABLED', 'ACCOUNT_UNAVAILABLE'],
    ['ACCOUNT_DELETED', 'ACCOUNT_UNAVAILABLE'],
    ['ACCOUNT_UNAVAILABLE', 'ACCOUNT_UNAVAILABLE'],
    ['CHALLENGE_NOT_FOUND', 'CHALLENGE_FAILED'],
    ['CHALLENGE_EXPIRED', 'CHALLENGE_FAILED'],
    ['CHALLENGE_ALREADY_CONSUMED', 'CHALLENGE_FAILED'],
    ['CHALLENGE_ATTEMPTS_EXCEEDED', 'CHALLENGE_FAILED'],
    ['OTP_MISMATCH', 'CHALLENGE_FAILED'],
    ['SESSION_NOT_FOUND', 'SESSION_INVALID'],
    ['SESSION_EXPIRED', 'SESSION_INVALID'],
    ['SESSION_REVOKED', 'SESSION_INVALID'],
    ['TOKEN_INVALID', 'SESSION_INVALID'],
    ['TOKEN_EXPIRED', 'SESSION_INVALID'],
    ['TOKEN_TENANT_MISMATCH', 'SESSION_INVALID'],
    ['TOKEN_HASH_NOT_FOUND', 'SESSION_INVALID'],
    ['RATE_LIMITED', 'RATE_LIMITED'],
    ['LOCKED', 'RATE_LIMITED'],
    ['POLICY_DENIED', 'AUTHORIZATION_FAILED'],
    ['ACCOUNT_LINKING_DENIED', 'AUTHORIZATION_FAILED'],
    ['STORE_UNAVAILABLE', 'TEMPORARILY_UNAVAILABLE'],
    ['DELIVERY_FAILED', 'TEMPORARILY_UNAVAILABLE'],
    ['SIDE_EFFECT_FAILED', 'TEMPORARILY_UNAVAILABLE'],
    ['EVENT_SINK_FAILED', 'TEMPORARILY_UNAVAILABLE'],
    ['PASSWORD_MISMATCH', 'AUTHENTICATION_FAILED'],
    ['CREDENTIAL_NOT_FOUND', 'AUTHENTICATION_FAILED'],
    ['IDENTITY_NOT_FOUND', 'AUTHENTICATION_FAILED'],
    ['AUTHENTICATION_FAILED', 'AUTHENTICATION_FAILED'],
    ['INTERNAL', 'INTERNAL']
  ])
  for (const [reason, publicCode] of mappings) {
    assert.equal(mapReason(reason), publicCode)
  }

  assert.equal(challengeResultToReason('already-consumed'), 'CHALLENGE_ALREADY_CONSUMED')
  assert.equal(challengeResultToReason('expired'), 'CHALLENGE_EXPIRED')
  assert.equal(challengeResultToReason('attempts-exceeded'), 'CHALLENGE_ATTEMPTS_EXCEEDED')
  assert.equal(challengeResultToReason('version-conflict'), 'CHALLENGE_VERSION_CONFLICT')
  assert.equal(challengeRecordFailedAttemptReason('attempts-exceeded'), 'CHALLENGE_ATTEMPTS_EXCEEDED')
  assert.equal(challengeRecordFailedAttemptReason('expired'), 'CHALLENGE_EXPIRED')
  assert.equal(challengeRecordFailedAttemptReason('version-conflict'), 'CHALLENGE_VERSION_CONFLICT')

  assert.equal(authErr(context, 'RATE_LIMITED', undefined, 10).error.publicError.retryAfterSeconds, 10)
  assert.equal(storeFailure(context, storeError()).error.internalReason, 'STORE_UNAVAILABLE')
  const malformedStoreFailure = storeFailure(context, {
    type: 'component.failure',
    component: 'store',
    reason: {
      type: 'raw-secret',
      reveal() {
        return 'must-not-cross'
      },
      toJSON() {
        return 'must-not-cross'
      }
    }
  } as never)
  assert.equal(malformedStoreFailure.error.internalReason, 'STORE_UNAVAILABLE')
  assert.equal(JSON.stringify(malformedStoreFailure).includes('must-not-cross'), false)
  assert.equal((await catchBoundary(context, async () => { throw new Error('private') })).error.internalReason, 'INTERNAL')
})

function config(options = {}) {
  return {
    idGenerator: {
      generate(input) {
        return options.generate ? options.generate(input) : `${input.kind}_generated`
      }
    },
    store: {
      durable: {
        accounts: {
          async create(input) {
            options.accountCreated?.(input)
            return options.createFailure ? { ok: false, error: storeError() } : { ok: true, value: input.record }
          },
          async findById() {
            return options.accountFailure
              ? { ok: false, error: storeError() }
              : { ok: true, value: options.account ?? null }
          }
        },
        identities: {
          async create(input) {
            options.identityCreated?.(input)
            return options.identityCreateFailure
              ? { ok: false, error: storeError() }
              : { ok: true, value: input.record }
          },
          async findBySubject() {
            return options.identityFailure
              ? { ok: false, error: storeError() }
              : { ok: true, value: options.identity ?? null }
          }
        }
      }
    }
  }
}

function storeError() {
  return {
    type: 'component.failure',
    component: 'store',
    reason: 'STORE_UNAVAILABLE'
  }
}
