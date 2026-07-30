import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createNodeCryptoProvider,
  createNodePasswordHasher,
  createNodeSecretSealer,
  protectedValue,
  rawSecret,
  sealedValue
} from '../src/index.ts'

test('raw secrets redact during serialization', () => {
  const secret = rawSecret('plain-token')

  assert.equal(secret.reveal(), 'plain-token')
  assert.equal(JSON.stringify(secret), '"[REDACTED]"')
})

test('secret factories normalize unsafe redactions and freeze wrappers', () => {
  const raw = rawSecret('top-secret', 'token=top-secret')
  const protectedSecret = protectedValue({
    type: 'protected-value',
    scheme: 'test.v1',
    value: 'hash-secret'
  }, 'hash=hash-secret')
  const sealedSecret = sealedValue({
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'key_1',
    ciphertext: 'cipher-secret'
  }, 'cipher=cipher-secret')
  const byteSecret = rawSecret(
    new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    'bytes=deadbeef'
  )

  assert.equal(JSON.stringify(raw), '"[REDACTED]"')
  assert.equal(JSON.stringify(protectedSecret), '"[REDACTED]"')
  assert.equal(JSON.stringify(sealedSecret), '"[REDACTED]"')
  assert.equal(JSON.stringify(byteSecret), '"[REDACTED]"')
  assert.equal(Object.isFrozen(raw), true)
  assert.equal(Object.isFrozen(protectedSecret), true)
  assert.equal(Object.isFrozen(sealedSecret), true)
  assert.equal(Reflect.set(raw, 'redacted', 'changed'), false)
})

test('secret wrappers snapshot mutable inputs and byte reveals', () => {
  const bytes = new Uint8Array([1, 2, 3])
  const raw = rawSecret(bytes)
  const protectedInput = {
    type: 'protected-value' as const,
    scheme: 'test.v1',
    value: 'verifier-before'
  }
  const sealedInput = {
    type: 'sealed-secret' as const,
    algorithm: 'test.v1',
    keyId: 'key_1',
    ciphertext: 'ciphertext-before'
  }
  const protectedSecret = protectedValue(protectedInput)
  const sealedSecret = sealedValue(sealedInput)

  bytes[0] = 9
  protectedInput.value = 'verifier-after'
  sealedInput.ciphertext = 'ciphertext-after'
  const firstReveal = raw.reveal()
  firstReveal[1] = 9

  assert.deepEqual([...raw.reveal()], [1, 2, 3])
  assert.equal(protectedSecret.revealForPersistence(), 'verifier-before')
  assert.equal(sealedSecret.revealCiphertextForPersistence(), 'ciphertext-before')
})

test('secret wrapper factories snapshot Date subclasses without overridable reads', () => {
  class StatefulDate extends Date {
    reads = 0

    override getTime(): number {
      this.reads += 1
      return this.reads === 1
        ? Date.prototype.getTime.call(this)
        : Number.NaN
    }
  }
  const createdAt = new StatefulDate('2026-01-01T00:00:00.000Z')
  const expiresAt = new StatefulDate('2026-01-01T00:05:00.000Z')

  const protectedSecret = protectedValue({
    type: 'protected-value',
    scheme: 'test.v1',
    value: 'verifier',
    createdAt
  })
  const sealedSecret = sealedValue({
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'key_1',
    ciphertext: 'ciphertext',
    expiresAt
  })

  assert.equal(protectedSecret.createdAt?.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(sealedSecret.expiresAt?.toISOString(), '2026-01-01T00:05:00.000Z')
  assert.equal(createdAt.reads, 0)
  assert.equal(expiresAt.reads, 0)
})

test('hash and hmac return protected values without exposing raw input', async () => {
  const crypto = createNodeCryptoProvider()
  const hashed = await crypto.hash({ value: rawSecret('raw-sample'), scheme: 'test-hash' })
  const mac = await crypto.hmac({
    key: rawSecret('key-sample'),
    value: rawSecret('raw-sample'),
    framing: 'hmac-sha256.v2',
    scheme: 'test-hmac'
  })

  assert.equal(hashed.ok, true)
  assert.equal(mac.ok, true)
  assert.equal(hashed.value.scheme, 'test-hash')
  assert.equal(mac.value.scheme, 'test-hmac')
  assert.equal(JSON.stringify({ hashed, mac }).includes('raw-sample'), false)
  assert.equal(JSON.stringify({ hashed, mac }).includes('key-sample'), false)
})

test('hmac authenticates domain-separation context', async () => {
  const crypto = createNodeCryptoProvider()
  const key = rawSecret('key-sample')
  const value = rawSecret('same-value')
  const first = await crypto.hmac({
    key,
    value,
    context: 'tenant-a:challenge-1',
    framing: 'hmac-sha256.v2',
    scheme: 'test-hmac.v2'
  })
  const second = await crypto.hmac({
    key,
    value,
    context: 'tenant-a:challenge-2',
    framing: 'hmac-sha256.v2',
    scheme: 'test-hmac.v2'
  })
  const repeated = await crypto.hmac({
    key,
    value,
    context: 'tenant-a:challenge-1',
    framing: 'hmac-sha256.v2',
    scheme: 'test-hmac.v2'
  })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(first.value.revealForPersistence(), second.value.revealForPersistence())
  assert.equal(first.value.revealForPersistence(), repeated.value.revealForPersistence())
})

test('hmac v2 framing separates contextual input from legacy reserved byte sequences', async () => {
  const crypto = createNodeCryptoProvider()
  const key = rawSecret('key-sample')
  const context = 'tenant-a:challenge-1'
  const value = 'same-value'
  const legacyFramedValue = `authmodules.hmac.context.v1\u0000${Buffer.byteLength(context)}\u0000${context}\u0000${value}`

  const contextual = await crypto.hmac({ key, value, context, framing: 'hmac-sha256.v2' })
  const contextless = await crypto.hmac({ key, value: legacyFramedValue, framing: 'hmac-sha256.v2' })
  const legacyProtected = protectedValue({
    type: 'protected-value',
    scheme: 'test-hmac.legacy',
    value: 'mtWX2mz80qyq1v9L3WsVmeUtOM7o2iJNSUBTn5vDJ44'
  })
  const legacyContextual = await crypto.verifyHmac({
    key,
    value,
    context,
    framing: 'hmac-sha256.legacy.v1',
    scheme: 'test-hmac.legacy',
    protectedValue: legacyProtected,
    upgradeScheme: 'test-hmac.v2'
  })
  const legacyContextless = await crypto.verifyHmac({
    key,
    value: legacyFramedValue,
    framing: 'hmac-sha256.legacy.v1',
    scheme: 'test-hmac.legacy',
    protectedValue: legacyProtected,
    upgradeScheme: 'test-hmac.v2'
  })

  assert.equal(contextual.ok, true)
  assert.equal(contextless.ok, true)
  assert.equal(contextual.value.scheme, 'hmac-sha256.v2')
  assert.notEqual(contextual.value.revealForPersistence(), contextless.value.revealForPersistence())
  assert.equal(legacyContextual.value.verified, true)
  assert.equal(legacyContextless.value.verified, true)
  assert.equal(legacyContextual.value.needsUpgrade, true)
  assert.notEqual(
    legacyContextual.value.upgradedValue.revealForPersistence(),
    legacyContextless.value.upgradedValue.revealForPersistence()
  )
})

test('hmac verification rejects malformed inputs and mismatched authenticators', async () => {
  const crypto = createNodeCryptoProvider()
  const key = rawSecret('key-sample')
  const value = rawSecret('same-value')
  const mac = await crypto.hmac({
    key,
    value,
    framing: 'hmac-sha256.v2',
    scheme: 'test-hmac.v2'
  })

  assert.equal(mac.ok, true)
  assert.deepEqual(
    await crypto.verifyHmac({
      key,
      value,
      framing: 'hmac-sha256.v2',
      scheme: 'test-hmac.v2',
      protectedValue: mac.value
    }),
    { ok: true, value: { verified: true, needsUpgrade: false } }
  )
  assert.deepEqual(
    await crypto.verifyHmac({
      key,
      value,
      framing: 'hmac-sha256.v2',
      scheme: 'another-hmac.v2',
      protectedValue: mac.value
    }),
    { ok: true, value: { verified: false } }
  )
  assert.deepEqual(
    await crypto.verifyHmac({
      key,
      value,
      framing: 'hmac-sha256.v2',
      scheme: 'test-hmac.v2',
      protectedValue: protectedValue({
        type: 'protected-value',
        scheme: 'test-hmac.v2',
        value: 'A'.repeat(43)
      })
    }),
    { ok: true, value: { verified: false } }
  )

  const invalidHmac = await crypto.hmac({
    key,
    value,
    framing: 'invalid' as 'hmac-sha256.v2'
  })
  const invalidContext = await crypto.hmac({
    key,
    value,
    context: '',
    framing: 'hmac-sha256.v2'
  })
  const invalidKey = await crypto.hmac({
    key: rawSecret(''),
    value,
    framing: 'hmac-sha256.v2'
  })
  const invalidVerification = await crypto.verifyHmac({
    key,
    value,
    framing: 'invalid' as 'hmac-sha256.v2',
    scheme: 'test-hmac.v2',
    protectedValue: mac.value
  })
  const invalidProtectedValue = await crypto.verifyHmac({
    key,
    value,
    framing: 'hmac-sha256.v2',
    scheme: 'test-hmac.v2',
    protectedValue: protectedValue({
      type: 'protected-value',
      scheme: 'test-hmac.v2',
      value: 'short'
    })
  })
  const canonical = mac.value.revealForPersistence()
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const lastIndex = alphabet.indexOf(canonical.at(-1))
  const nonCanonicalAlias = `${canonical.slice(0, -1)}${alphabet[lastIndex + 1]}`
  const invalidAlias = await crypto.verifyHmac({
    key,
    value,
    framing: 'hmac-sha256.v2',
    scheme: 'test-hmac.v2',
    protectedValue: protectedValue({
      type: 'protected-value',
      scheme: 'test-hmac.v2',
      value: nonCanonicalAlias
    })
  })

  for (const result of [
    invalidHmac,
    invalidContext,
    invalidKey,
    invalidVerification,
    invalidProtectedValue,
    invalidAlias
  ]) {
    assert.equal(result.ok, false)
    assert.equal(result.error.reason, 'CRYPTO_FAILED')
  }
})

test('hmac verification snapshots persisted authenticators exactly once', async () => {
  const crypto = createNodeCryptoProvider()
  const key = rawSecret('key-sample')
  const value = rawSecret('same-value')
  const mac = await crypto.hmac({
    key,
    value,
    framing: 'hmac-sha256.v2',
    scheme: 'test-hmac.v2'
  })
  assert.equal(mac.ok, true)
  const expected = mac.value.revealForPersistence()
  let reads = 0
  const stateful = {
    type: 'protected-value' as const,
    scheme: 'test-hmac.v2',
    redacted: '[REDACTED]',
    revealForPersistence() {
      reads += 1
      return reads === 1 ? 'A'.repeat(43) : expected
    },
    toJSON() {
      return '[REDACTED]'
    }
  }

  const result = await crypto.verifyHmac({
    key,
    value,
    framing: 'hmac-sha256.v2',
    scheme: 'test-hmac.v2',
    protectedValue: stateful
  })

  assert.deepEqual(result, { ok: true, value: { verified: false } })
  assert.equal(reads, 1)
})

test('password hasher verifies correct password and rejects mismatches', async () => {
  const hasher = createNodePasswordHasher({ iterations: 600_000, keyLength: 32 })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const protectedPassword = await hasher.hashPassword({
    password: rawSecret('correct'),
    now
  })

  assert.equal(protectedPassword.ok, true)

  const verified = await hasher.verifyPassword({
    password: rawSecret('correct'),
    protectedPassword: protectedPassword.value,
    now
  })
  const rejected = await hasher.verifyPassword({
    password: rawSecret('wrong'),
    protectedPassword: protectedPassword.value,
    now
  })

  assert.deepEqual(verified.value, { verified: true, needsRehash: false })
  assert.deepEqual(rejected.value, { verified: false })
})

test('password verification upgrades weaker PBKDF2 material after a successful match', async () => {
  const weak = createNodePasswordHasher({ iterations: 600_000, keyLength: 32 })
  const strong = createNodePasswordHasher({ iterations: 600_001, keyLength: 64 })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const original = await weak.hashPassword({ password: rawSecret('correct'), now })

  const result = await strong.verifyPassword({
    password: rawSecret('correct'),
    protectedPassword: original.value,
    now
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.verified, true)
  assert.equal(result.value.needsRehash, true)
  const upgraded = await strong.verifyPassword({
    password: rawSecret('correct'),
    protectedPassword: result.value.upgradedValue,
    now
  })
  assert.deepEqual(upgraded, {
    ok: true,
    value: { verified: true, needsRehash: false }
  })
})

test('password parser rejects trailing PBKDF2 segments', async () => {
  const hasher = createNodePasswordHasher({ iterations: 600_000, keyLength: 32 })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const original = await hasher.hashPassword({ password: rawSecret('correct'), now })
  const forged = protectedValue({
    type: 'protected-value',
    scheme: original.value.scheme,
    value: `${original.value.revealForPersistence()}.ignored`,
    createdAt: now
  })

  const result = await hasher.verifyPassword({
    password: rawSecret('correct'),
    protectedPassword: forged,
    now
  })

  assert.equal(result.ok, false)
})

test('secret sealer round-trips values for the same purpose', async () => {
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(7)),
    keyId: 'test-key'
  })
  const sealed = await sealer.seal({
    value: rawSecret('sealed-value'),
    purpose: 'test-purpose',
    expiresAt: new Date('2026-01-01T00:05:00.000Z')
  })

  assert.equal(sealed.ok, true)
  assert.equal(sealed.value.keyId, 'test-key')

  const unsealed = await sealer.unseal({
    value: sealed.value,
    purpose: 'test-purpose',
    now: new Date('2026-01-01T00:00:00.000Z')
  })

  assert.equal(unsealed.ok, true)
  assert.equal(unsealed.value.reveal(), 'sealed-value')
})

test('secret sealer preserves byte values and rejects expired or tampered expiry metadata', async () => {
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(9)),
    keyId: 'test-key'
  })
  const expiresAt = new Date('2026-01-01T00:05:00.000Z')
  const sealed = await sealer.seal({
    value: rawSecret(new Uint8Array([1, 2, 3])),
    purpose: 'outbox:delivery',
    expiresAt
  })

  const valid = await sealer.unseal({
    value: sealed.value,
    purpose: 'outbox:delivery',
    now: new Date('2026-01-01T00:04:59.999Z')
  })
  const expired = await sealer.unseal({
    value: sealed.value,
    purpose: 'outbox:delivery',
    now: expiresAt
  })
  const tampered = await sealer.unseal({
    value: {
      ...sealed.value,
      expiresAt: new Date('2026-01-01T00:10:00.000Z')
    },
    purpose: 'outbox:delivery',
    now: new Date('2026-01-01T00:04:59.999Z')
  })

  assert.equal(valid.ok, true)
  assert.deepEqual([...valid.value.reveal()], [1, 2, 3])
  assert.equal(expired.ok, false)
  assert.equal(tampered.ok, false)
})

test('secret sealer snapshots expiry once and rejects stateful expired descriptors', async () => {
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(9)),
    keyId: 'test-key'
  })
  const expiresAt = new Date('2020-01-01T00:00:00.000Z')
  const sealed = await sealer.seal({
    value: rawSecret('must-not-reveal'),
    purpose: 'outbox:delivery',
    expiresAt
  })
  assert.equal(sealed.ok, true)

  let expiryReads = 0
  const stateful = Object.defineProperty({ ...sealed.value }, 'expiresAt', {
    enumerable: true,
    get() {
      expiryReads += 1
      return expiryReads === 2 ? undefined : expiresAt
    }
  })
  const result = await sealer.unseal({
    value: stateful,
    purpose: 'outbox:delivery',
    now: new Date('2026-01-01T00:00:00.000Z')
  })

  assert.equal(result.ok, false)
  assert.equal(expiryReads, 1)
})

test('secret sealer rejects non-canonical ciphertext segments', async () => {
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(9)),
    keyId: 'test-key'
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const sealed = await sealer.seal({
    value: rawSecret('sealed-value'),
    purpose: 'outbox:delivery'
  })
  const ciphertext = sealed.value.revealCiphertextForPersistence()
  const forged = {
    ...sealed.value,
    revealCiphertextForPersistence() {
      return `${ciphertext}.ignored`
    }
  }

  const result = await sealer.unseal({ value: forged, purpose: 'outbox:delivery', now })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'CRYPTO_FAILED')
})

test('secret sealer enforces the persisted ciphertext boundary before encryption', async () => {
  const sealer = createNodeSecretSealer({
    key: rawSecret(new Uint8Array(32).fill(9)),
    keyId: 'test-key'
  })
  const boundary = await sealer.seal({
    value: rawSecret('x'.repeat(3_749_969)),
    purpose: 'outbox:delivery'
  })
  const oversized = await sealer.seal({
    value: rawSecret('x'.repeat(3_749_970)),
    purpose: 'outbox:delivery'
  })

  assert.equal(boundary.ok, true)
  assert.equal(boundary.value.revealCiphertextForPersistence().length, 5_000_000)
  assert.equal(oversized.ok, false)
  assert.equal(oversized.error.reason, 'CRYPTO_FAILED')
})

test('secret sealer rejects ambiguous or weak key material', () => {
  assert.throws(() => createNodeSecretSealer(), /options/)
  assert.throws(
    () => createNodeSecretSealer({ key: rawSecret('local-test-key') }),
    /exactly 32 bytes/
  )
  assert.throws(
    () => createNodeSecretSealer({ key: new Uint8Array(31) }),
    /exactly 32 bytes/
  )
  assert.throws(
    () => createNodeSecretSealer({ key: new Uint8Array(32), keyId: '' }),
    /keyId/
  )
})

test('password hasher rejects unsafe work factors', () => {
  assert.throws(
    () => createNodePasswordHasher({ iterations: 599_999 }),
    /PBKDF2 options/
  )
  assert.throws(
    () => createNodePasswordHasher({ keyLength: 31 }),
    /PBKDF2 options/
  )
})

test('secret string generation validates alphabet and length', () => {
  const crypto = createNodeCryptoProvider()
  assert.throws(
    () => crypto.randomSecretString({ kind: 'base64url', bytes: 0 }),
    /positive integer/
  )
  assert.throws(
    () => crypto.randomSecretString({ kind: 'alphabet', alphabet: '0', length: 6 }),
    /invalid/
  )
  assert.throws(
    () => crypto.randomSecretString({ kind: 'alphabet', alphabet: '001', length: 6 }),
    /invalid/
  )
  assert.throws(
    () => crypto.randomSecretString({ kind: 'alphabet', alphabet: '01', length: 1_048_577 }),
    /invalid/
  )
  assert.throws(() => crypto.randomPublicBytes(0), /Byte length/)
  assert.throws(() => crypto.randomSecretBytes(1_048_577), /Byte length/)
  assert.equal(
    crypto.randomSecretString({ kind: 'alphabet', alphabet: '0123456789', length: 64 }).reveal().length,
    64
  )
  assert.equal(crypto.randomSecretString({ kind: 'base64url', bytes: 16 }).reveal().length, 22)
})

test('timing-safe equality rejects invalid and differently sized inputs', () => {
  const crypto = createNodeCryptoProvider()

  assert.equal(crypto.timingSafeEqual(null as unknown as Uint8Array, new Uint8Array()), false)
  assert.equal(crypto.timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false)
  assert.equal(crypto.timingSafeEqual(new Uint8Array([1]), new Uint8Array([1])), true)
  assert.equal(crypto.timingSafeEqual(new Uint8Array([1]), new Uint8Array([2])), false)
})
