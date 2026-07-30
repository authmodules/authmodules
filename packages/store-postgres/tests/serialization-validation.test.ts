import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAccountRecord,
  isChallengeBinding,
  isIdentityLookup,
  isMethodMaterial,
  isPublicData,
  isRuntimeProtectedValue
} from '../src/records/validation.ts'
import { persistedJson, persistedPlainJson } from '../src/serialization/json.ts'
import {
  persistedTokenHash,
  reviveSecrets,
  serializeSecrets
} from '../src/serialization/secrets.ts'

test('secret serialization round-trips shallow method material', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const material = {
    schemaVersion: 'password.v1',
    publicData: { algorithm: 'argon2id', parameters: [3, 65536, true, null] },
    privateData: {
      passwordHash: protectedValue('hash', now),
      recoveryCode: sealedValue('ciphertext', now),
      note: { rotated: false }
    }
  }

  assert.equal(isMethodMaterial(material), true)
  const persisted = persistedJson(material)
  assert.equal(persisted.ok, true)
  const stored = JSON.parse(persisted.value)
  assert.deepEqual(stored.privateData.passwordHash, {
    type: 'protected-value',
    scheme: 'test.v1',
    value: 'hash',
    keyId: 'primary',
    createdAt: now.toISOString()
  })
  assert.deepEqual(stored.privateData.recoveryCode, {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'primary',
    ciphertext: 'ciphertext',
    expiresAt: now.toISOString()
  })

  const revived = reviveSecrets(stored)
  assert.equal(isMethodMaterial(revived), true)
  assert.equal(revived.privateData.passwordHash.revealForPersistence(), 'hash')
  assert.equal(revived.privateData.recoveryCode.revealCiphertextForPersistence(), 'ciphertext')

  const tokenHash = persistedTokenHash(material.privateData.passwordHash)
  assert.equal(tokenHash.ok, true)
  assert.deepEqual(tokenHash.value, {
    json: JSON.stringify(stored.privateData.passwordHash),
    scheme: 'test.v1',
    keyId: 'primary',
    verifier: 'hash'
  })
})

test('secret serializers reject raw, malformed, cyclic, and nested public values', () => {
  const cyclic = {}
  cyclic.self = cyclic

  assert.throws(() => serializeSecrets(rawSecret('plain')), /cannot be persisted/)
  assert.throws(() => serializeSecrets(new Date()), /invalid/)
  assert.throws(() => serializeSecrets([undefined]), /undefined/)
  assert.throws(() => serializeSecrets(cyclic), /cycles/)
  assert.throws(() => reviveSecrets({ type: 'protected-value', scheme: '', value: 'hash' }), /invalid/)
  assert.throws(() => reviveSecrets({
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'primary',
    ciphertext: 'ciphertext',
    expiresAt: 'invalid'
  }), /invalid/)
  assert.throws(() => reviveSecrets(cyclic), /invalid/)
  const largeCiphertext = 'x'.repeat(4_000_000)
  assert.throws(() => serializeSecrets([
    sealedValue(largeCiphertext),
    sealedValue(largeCiphertext),
    sealedValue(largeCiphertext)
  ]), /too large/)
  assert.throws(() => reviveSecrets([
    storedSealedValue(largeCiphertext),
    storedSealedValue(largeCiphertext),
    storedSealedValue(largeCiphertext)
  ]), /too large/)

  assert.deepEqual(persistedPlainJson(undefined), { ok: true, value: null })
  assert.equal(persistedPlainJson({ safe: ['value', 1, true, null] }).ok, true)
  assert.equal(persistedPlainJson({ secret: { type: 'protected-value', value: 'hash' } }).ok, false)
  assert.equal(persistedPlainJson({ invalid: Number.POSITIVE_INFINITY }).ok, false)
})

test('record validators enforce exact lookup, binding, public, and secret shapes', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email',
    display: 'User'
  }
  assert.equal(isIdentityLookup(lookup), true)
  assert.equal(isIdentityLookup({ ...lookup, privateValue: 'must-not-cross' }), false)

  for (const account of [
    { mode: 'create-new-account' },
    { mode: 'require-existing-identity' },
    { mode: 'create-account-if-identity-missing' },
    { mode: 'link-to-actor-account' }
  ]) {
    assert.equal(isChallengeBinding({
      account,
      session: { ttlSeconds: 300 },
      startedByActor: { type: 'account', accountId: 'account_1' }
    }), true)
  }
  assert.equal(isChallengeBinding({
    account: { mode: 'create-new-account' },
    startedByActor: { type: 'anonymous' }
  }), true)
  assert.equal(isChallengeBinding({
    account: { mode: 'create-new-account' },
    startedByActor: { type: 'system', name: 'worker' }
  }), true)
  assert.equal(isChallengeBinding({
    account: { mode: 'create-new-account' },
    policyInput: { role: 'private' }
  }), false)

  assert.equal(isPublicData({ nested: { values: ['safe'] } }), true)
  assert.equal(isPublicData({ verifier: { type: 'protected-value', value: 'hash' } }), false)
  const extendedArray: unknown[] & { extra?: unknown } = []
  extendedArray.extra = 'must-not-cross'
  assert.equal(isPublicData({ map: new Map([['key', 'value']]) }), false)
  assert.equal(isPublicData({ extendedArray }), false)
  assert.equal(isRuntimeProtectedValue(protectedValue('hash', now)), true)
  assert.equal(isRuntimeProtectedValue({ type: 'protected-value', scheme: 'test.v1' }), false)

  class HostileDate extends Date {
    override getTime(): number {
      throw new Error('hostile getTime')
    }
  }
  assert.equal(isAccountRecord({
    tenantId: 'tenant_1',
    accountId: 'account_1',
    status: 'active',
    createdAt: new HostileDate('invalid'),
    updatedAt: now
  }), false)
  assert.equal(isAccountRecord({
    tenantId: 'tenant_1',
    accountId: 'account_1',
    status: 'active',
    createdAt: new Proxy(new Date(now), {
      getPrototypeOf() {
        throw new Error('hostile prototype')
      }
    }),
    updatedAt: now
  }), false)
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

function protectedValue(value, createdAt) {
  return {
    type: 'protected-value',
    scheme: 'test.v1',
    keyId: 'primary',
    redacted: '[REDACTED]',
    createdAt,
    revealForPersistence() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function sealedValue(value, expiresAt) {
  return {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'primary',
    redacted: '[REDACTED]',
    expiresAt,
    revealCiphertextForPersistence() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function storedSealedValue(ciphertext) {
  return {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'primary',
    ciphertext
  }
}
