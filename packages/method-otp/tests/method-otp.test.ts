import test from 'node:test'
import assert from 'node:assert/strict'
import { createOtpMethod, normalizeOtpSubject } from '../src/index.ts'

test('normalizes OTP email subjects', () => {
  assert.equal(normalizeOtpSubject(' User@Example.TEST '), 'user@example.test')
  assert.equal(normalizeOtpSubject(' UserName ', 'username'), 'UserName')
})

test('begin creates challenge material and sends to the canonical subject', async () => {
  const method = createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey(), codeLength: 6 })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const validated = method.operations.begin.validate({
    subject: 'User@Example.TEST',
    locale: 'en',
    publicData: { flow: 'login' }
  })

  assert.equal(validated.ok, true)

  const result = await method.operations.begin.run(validated.value.value, {
    now,
    lookup: validated.value.lookup,
    auth: { tenantId: 'tenant_1' },
    challenge: { challengeId: 'challenge_1' }
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.challengeMaterial.privateData.codeHash.revealForPersistence(), otpHash('123456'))
  assert.equal(result.value.challengeMaterial.privateData.codeHash.scheme, 'otp-hmac-sha256.v3')
  assert.equal(result.value.sideEffects[0].dispatchPolicy, 'required')
  assert.equal(result.value.sideEffects[0].expiresAt.getTime(), now.getTime() + 300000)
  assert.equal(result.value.sideEffects[0].message.data.code.reveal(), '123456')
  assert.equal(result.value.sideEffects[0].message.to.target, 'user@example.test')
})

test('OTP snapshots verification keys and generated codes before async boundaries', async () => {
  const mutableKey = new Uint8Array(32).fill(1)
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
  let randomReveals = 0
  let observedKey
  let observedCode
  let verifierReveals = 0
  const method = createOtpMethod({
    verificationKey: rawSecret(mutableKey),
    crypto: {
      randomSecretString() {
        return {
          type: 'raw-secret',
          redacted: '[REDACTED]',
          reveal() {
            randomReveals += 1
            return randomReveals === 1 ? '123456' : '654321'
          },
          toJSON() {
            return '[REDACTED]'
          }
        }
      },
      async hmac(input) {
        observedKey = input.key.reveal()
        observedCode = input.value.reveal()
        return {
          ok: true,
          value: {
            type: 'protected-value',
            scheme: input.scheme,
            createdAt,
            redacted: '[REDACTED]',
            revealForPersistence() {
              verifierReveals += 1
              return verifierReveals === 1 ? 'stable-verifier' : 'mutated-verifier'
            },
            toJSON() {
              return '[REDACTED]'
            }
          }
        }
      },
      async verifyHmac() {
        throw new Error('not used by begin')
      }
    }
  })
  mutableKey.fill(9)
  const validated = method.operations.begin.validate({ subject: 'user@example.test' })
  const result = await method.operations.begin.run(validated.value.value, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    lookup: validated.value.lookup,
    auth: { tenantId: 'tenant_1' },
    challenge: { challengeId: 'challenge_1' }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(observedKey, new Uint8Array(32).fill(1))
  assert.equal(observedCode, '123456')
  assert.equal(result.value.sideEffects[0].message.data.code.reveal(), '123456')
  assert.equal(result.value.challengeMaterial.privateData.codeHash.revealForPersistence(), 'stable-verifier')
  assert.equal(
    result.value.challengeMaterial.privateData.codeHash.createdAt.toISOString(),
    '2026-01-01T00:00:00.000Z'
  )
  assert.equal(result.value.challengeMaterial.privateData.codeHash.revealForPersistence(), 'stable-verifier')
  assert.equal(JSON.stringify(result.value.sideEffects[0].message.data.code), '"[REDACTED]"')
  assert.equal(JSON.stringify(result.value.challengeMaterial.privateData.codeHash), '"[REDACTED]"')
  assert.equal(randomReveals, 1)
  assert.equal(verifierReveals, 1)
  assert.equal(createdAt.reads, 0)
})

test('begin uses only an explicitly configured trusted delivery target resolver', async () => {
  const method = createOtpMethod({
    crypto: fakeCrypto(),
    verificationKey: verificationKey(),
    resolveDeliveryTarget({ lookup, context }) {
      assert.equal('metadata' in context, false)
      assert.deepEqual(context.policyInput, { senderProfile: 'transactional' })
      return `verified:${lookup.subject}`
    }
  })
  const validated = method.operations.begin.validate({
    subject: 'User@Example.TEST',
    display: 'untrusted@example.test',
    deliveryTarget: 'untrusted@example.test'
  })

  const result = await method.operations.begin.run(validated.value.value, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    lookup: validated.value.lookup,
    auth: {
      tenantId: 'tenant_1',
      policyInput: { senderProfile: 'transactional' },
      metadata: { mustNotReachResolver: true }
    },
    challenge: { challengeId: 'challenge_1' }
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.sideEffects[0].message.to.target, 'verified:user@example.test')
})

test('complete verifies OTP hash and returns proof', async () => {
  const method = createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey() })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const validated = method.operations.complete.validate({
    code: rawSecret('123456')
  })

  const result = await method.operations.complete.run(validated.value.value, {
    now,
    lookup: otpLookup(),
    auth: { tenantId: 'tenant_1' },
    challenge: {
      challengeId: 'challenge_1',
      challengeMaterial: {
        schemaVersion: 'otp.v1',
        privateData: {
          codeHash: protectedValue(otpHash('123456'), 'otp-hmac-sha256.v2')
        }
      }
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.proof.primaryIdentity.subject, 'user@example.test')
  assert.equal(result.value.proof.assurance.factors[0], 'otp')
})

test('complete uses explicit legacy framing only for v2 challenge verifiers', async () => {
  const framings = []
  const crypto = {
    ...fakeCrypto(),
    async verifyHmac(input) {
      framings.push(input.framing)
      return fakeCrypto().verifyHmac(input)
    }
  }
  const method = createOtpMethod({ crypto, verificationKey: verificationKey() })
  const validated = method.operations.complete.validate({ code: rawSecret('123456') })
  const context = {
    now: new Date('2026-01-01T00:00:00.000Z'),
    lookup: otpLookup(),
    auth: { tenantId: 'tenant_1' },
    challenge: {
      challengeId: 'challenge_1',
      challengeMaterial: {
        schemaVersion: 'otp.v1',
        privateData: {
          codeHash: protectedValue(otpHash('123456'), 'otp-hmac-sha256.v2')
        }
      }
    }
  }

  const legacy = await method.operations.complete.run(validated.value.value, context)
  const current = await method.operations.complete.run(validated.value.value, {
    ...context,
    challenge: {
      ...context.challenge,
      challengeMaterial: {
        ...context.challenge.challengeMaterial,
        privateData: {
          codeHash: protectedValue(otpHash('123456'), 'otp-hmac-sha256.v3')
        }
      }
    }
  })

  assert.equal(legacy.ok, true)
  assert.equal(current.ok, true)
  assert.deepEqual(framings, ['hmac-sha256.legacy.v1', 'hmac-sha256.v2'])
})

test('complete maps OTP mismatch to challenge failure attempt', async () => {
  const method = createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey() })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const validated = method.operations.complete.validate({
    code: rawSecret('000000')
  })

  const result = await method.operations.complete.run(validated.value.value, {
    now,
    lookup: otpLookup(),
    auth: { tenantId: 'tenant_1' },
    challenge: {
      challengeId: 'challenge_1',
      challengeMaterial: {
        schemaVersion: 'otp.v1',
        privateData: {
          codeHash: protectedValue(otpHash('123456'), 'otp-hmac-sha256.v2')
        }
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'OTP_MISMATCH')
  assert.equal(result.error.countsAsAttempt, true)
  assert.equal(result.error.safePublicCodeHint, 'CHALLENGE_FAILED')
})

test('OTP verifier is bound to tenant and challenge id', async () => {
  const method = createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey() })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const validated = method.operations.begin.validate({ subject: 'user@example.test' })
  const first = await method.operations.begin.run(validated.value.value, {
    now,
    lookup: validated.value.lookup,
    auth: { tenantId: 'tenant_1' },
    challenge: { challengeId: 'challenge_1' }
  })
  const second = await method.operations.begin.run(validated.value.value, {
    now,
    lookup: validated.value.lookup,
    auth: { tenantId: 'tenant_1' },
    challenge: { challengeId: 'challenge_2' }
  })

  const firstHash = first.value.challengeMaterial.privateData.codeHash
  const secondHash = second.value.challengeMaterial.privateData.codeHash
  assert.notEqual(firstHash.revealForPersistence(), secondHash.revealForPersistence())

  const complete = method.operations.complete.validate({ code: rawSecret('123456') })
  const replay = await method.operations.complete.run(complete.value.value, {
    now,
    lookup: otpLookup(),
    auth: { tenantId: 'tenant_1' },
    challenge: {
      challengeId: 'challenge_2',
      challengeMaterial: {
        schemaVersion: 'otp.v1',
        privateData: { codeHash: firstHash }
      }
    }
  })
  assert.equal(replay.ok, false)
  assert.equal(replay.error.reason, 'OTP_MISMATCH')
})

test('complete treats missing challenge verifier as internal method failure', async () => {
  const method = createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey() })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const validated = method.operations.complete.validate({
    code: rawSecret('123456')
  })

  const result = await method.operations.complete.run(validated.value.value, {
    now,
    lookup: otpLookup(),
    auth: { tenantId: 'tenant_1' },
    challenge: {
      challengeId: 'challenge_1',
      challengeMaterial: { schemaVersion: 'otp.v1' }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'INTERNAL')
  assert.equal(result.error.countsAsAttempt, false)
  assert.equal(result.error.safePublicCodeHint, 'CHALLENGE_FAILED')
})

test('complete refuses stored algorithm substitution and missing bound lookup', async () => {
  const method = createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey() })
  const validated = method.operations.complete.validate({ code: rawSecret('123456') })
  const result = await method.operations.complete.run(validated.value.value, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    auth: { tenantId: 'tenant_1' },
    challenge: {
      challengeId: 'challenge_1',
      challengeMaterial: {
        schemaVersion: 'otp.v1',
        privateData: { codeHash: protectedValue('hmac:123456', 'sha256.v1') }
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'INTERNAL')
})

test('complete fails closed for unknown challenge material versions', async () => {
  const method = createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey() })
  const validated = method.operations.complete.validate({ code: rawSecret('123456') })
  const result = await method.operations.complete.run(validated.value.value, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    lookup: otpLookup(),
    auth: { tenantId: 'tenant_1' },
    challenge: {
      challengeId: 'challenge_1',
      challengeMaterial: {
        schemaVersion: 'otp.v2',
        privateData: {
          codeHash: protectedValue(otpHash('123456'), 'otp-hmac-sha256.v2')
        }
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'INTERNAL')
})

test('rejects weak OTP configuration and secret-bearing public data', () => {
  assert.throws(
    () => createOtpMethod({ crypto: fakeCrypto(), verificationKey: rawSecret('weak') }),
    /32 bytes/
  )
  assert.throws(
    () => createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey(), codeLength: 5 }),
    /configuration/
  )
  assert.throws(
    () => createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey(), alphabet: '00123456789' }),
    /configuration/
  )
  assert.throws(
    () => createOtpMethod({
      crypto: {
        randomSecretString: fakeCrypto().randomSecretString,
        hmac: fakeCrypto().hmac
      },
      verificationKey: verificationKey()
    }),
    /crypto/
  )
  assert.doesNotThrow(() => createOtpMethod({
    crypto: {
      randomSecretString: fakeCrypto().randomSecretString,
      hmac: fakeCrypto().hmac,
      verifyHmac: fakeCrypto().verifyHmac
    },
    verificationKey: verificationKey()
  }))
  const method = createOtpMethod({ crypto: fakeCrypto(), verificationKey: verificationKey() })
  const result = method.operations.begin.validate({
    subject: 'user@example.test',
    publicData: { leaked: rawSecret('secret') }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.issues[0].path[0], 'publicData')

  const cyclic = {}
  cyclic.self = cyclic
  const cyclicResult = method.operations.begin.validate({
    subject: 'user@example.test',
    publicData: cyclic
  })
  const disguised = method.operations.begin.validate({
    subject: 'user@example.test',
    publicData: {
      leaked: { type: 'sealed-secret', algorithm: 'test.v1', keyId: 'test', ciphertext: 'must-not-cross' }
    }
  })
  const oversizedCode = method.operations.complete.validate({ code: rawSecret('1'.repeat(10_000)) })
  const extendedArray: unknown[] & { extra?: unknown } = []
  extendedArray.extra = { type: 'raw-secret', leak: 'must-not-cross' }
  const nonJsonData = method.operations.begin.validate({
    subject: 'user@example.test',
    publicData: { bytes: new Uint8Array([1, 2]), extendedArray }
  })
  assert.equal(cyclicResult.ok, false)
  assert.equal(disguised.ok, false)
  assert.equal(oversizedCode.ok, false)
  assert.equal(nonJsonData.ok, false)
})

test('maps thrown crypto errors to method crypto failures', async () => {
  const method = createOtpMethod({
    verificationKey: verificationKey(),
    crypto: {
      randomSecretString() {
        throw new Error('rng unavailable')
      },
      async hmac() {
        throw new Error('hash unavailable')
      },
      async verifyHmac() {
        throw new Error('verification unavailable')
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const begin = method.operations.begin.validate({ subject: 'user@example.test' })
  const complete = method.operations.complete.validate({
    code: rawSecret('123456')
  })

  const beginResult = await method.operations.begin.run(begin.value.value, {
    now,
    lookup: begin.value.lookup,
    auth: { tenantId: 'tenant_1' },
    challenge: { challengeId: 'challenge_1' }
  })
  const completeResult = await method.operations.complete.run(complete.value.value, {
    now,
    lookup: otpLookup(),
    auth: { tenantId: 'tenant_1' },
    challenge: {
      challengeId: 'challenge_1',
      challengeMaterial: {
        schemaVersion: 'otp.v1',
        privateData: {
          codeHash: protectedValue(otpHash('123456'), 'otp-hmac-sha256.v2')
        }
      }
    }
  })

  assert.equal(beginResult.ok, false)
  assert.equal(beginResult.error.reason, 'CRYPTO_FAILED')
  assert.equal(completeResult.ok, false)
  assert.equal(completeResult.error.reason, 'CRYPTO_FAILED')
})

test('maps malformed crypto successes to method crypto failures', async () => {
  const method = createOtpMethod({
    verificationKey: verificationKey(),
    crypto: {
      randomSecretString() {
        return {}
      },
      async hmac() {
        return { ok: true, value: {} }
      },
      async verifyHmac() {
        return { ok: true, value: {} }
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const begin = method.operations.begin.validate({ subject: 'user@example.test' })
  const result = await method.operations.begin.run(begin.value.value, {
    now,
    lookup: begin.value.lookup,
    auth: { tenantId: 'tenant_1' },
    challenge: { challengeId: 'challenge_1' }
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'CRYPTO_FAILED')

  const wrongLength = createOtpMethod({
    verificationKey: verificationKey(),
    crypto: {
      randomSecretString() {
        return rawSecret('123')
      },
      async hmac(input) {
        return { ok: true, value: protectedValue('hash', input.scheme) }
      },
      async verifyHmac() {
        return { ok: true, value: { verified: false } }
      }
    }
  })
  const wrongLengthResult = await wrongLength.operations.begin.run(begin.value.value, {
    now,
    lookup: begin.value.lookup,
    auth: { tenantId: 'tenant_1' },
    challenge: { challengeId: 'challenge_1' }
  })
  assert.equal(wrongLengthResult.ok, false)
  assert.equal(wrongLengthResult.error.reason, 'CRYPTO_FAILED')

  const emptyVerifier = createOtpMethod({
    verificationKey: verificationKey(),
    crypto: {
      randomSecretString() {
        return rawSecret('123456')
      },
      async hmac(input) {
        return { ok: true, value: protectedValue('', input.scheme) }
      },
      async verifyHmac() {
        return { ok: true, value: { verified: false } }
      }
    }
  })
  const emptyVerifierResult = await emptyVerifier.operations.begin.run(begin.value.value, {
    now,
    lookup: begin.value.lookup,
    auth: { tenantId: 'tenant_1' },
    challenge: { challengeId: 'challenge_1' }
  })
  assert.equal(emptyVerifierResult.ok, false)
  assert.equal(emptyVerifierResult.error.reason, 'CRYPTO_FAILED')
})

function fakeCrypto() {
  return {
    randomSecretString() {
      return rawSecret('123456')
    },
    async hmac(input) {
      return { ok: true, value: protectedValue(`hmac:${input.context}:${input.value.reveal()}`, input.scheme) }
    },
    async verifyHmac(input) {
      const expected = `hmac:${input.context}:${input.value.reveal()}`
      if (input.protectedValue.scheme !== input.scheme
        || input.protectedValue.revealForPersistence() !== expected) {
        return { ok: true, value: { verified: false } }
      }
      if (input.framing === 'hmac-sha256.legacy.v1') {
        return {
          ok: true,
          value: {
            verified: true,
            needsUpgrade: true,
            upgradedValue: protectedValue(expected, input.upgradeScheme)
          }
        }
      }
      return { ok: true, value: { verified: true, needsUpgrade: false } }
    },
    timingSafeEqual(left, right) {
      return Buffer.from(left).equals(Buffer.from(right))
    }
  }
}

function otpHash(code, tenantId = 'tenant_1', challengeId = 'challenge_1') {
  const context = JSON.stringify(['authmodules.otp.challenge.v1', tenantId, challengeId])
  return `hmac:${context}:${code}`
}

function verificationKey() {
  return rawSecret(new Uint8Array(32).fill(1))
}

function otpLookup() {
  return {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email',
    display: 'user@example.test'
  }
}

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

function protectedValue(value, scheme) {
  return {
    type: 'protected-value',
    scheme,
    redacted: '[REDACTED]',
    revealForPersistence() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}
