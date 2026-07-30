import test from 'node:test'
import assert from 'node:assert/strict'
import { createPasswordMethod, normalizePasswordSubject } from '../src/index.ts'

test('normalizes email subjects for password identities', () => {
  assert.equal(normalizePasswordSubject(' User@Example.TEST '), 'user@example.test')
  assert.equal(normalizePasswordSubject(' UserName ', 'username'), 'UserName')
})

test('enroll hashes passwords into credential material', async () => {
  const method = createPasswordMethod({ passwordHasher: fakePasswordHasher() })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const validated = method.operations.enroll.validate({
    subject: ' User@Example.TEST ',
    password: rawSecret('correct horse'),
    publicData: { label: 'primary' }
  }, {})

  assert.equal(validated.ok, true)

  const result = await method.operations.enroll.run(validated.value.value, {
    now,
    lookup: validated.value.lookup
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.identity.subject, 'user@example.test')
  assert.equal(result.value.identity.verifiedAt, undefined)
  assert.equal(result.value.credentialMaterial.privateData.passwordHash.revealForPersistence(), 'hash:correct horse')
  assert.equal(result.value.proof.assurance.factors[0], 'password')
})

test('validation snapshots stateful password wrappers', () => {
  const method = createPasswordMethod({ passwordHasher: fakePasswordHasher() })
  let revealed = 'original-password'
  const validated = method.operations.enroll.validate({
    subject: 'user@example.test',
    password: {
      type: 'raw-secret',
      redacted: '[REDACTED]',
      reveal() {
        return revealed
      },
      toJSON() {
        return '[REDACTED]'
      }
    }
  }, {})

  revealed = 'mutated-password'

  assert.equal(validated.ok, true)
  assert.equal(validated.value.value.password.reveal(), 'original-password')
  assert.equal(JSON.stringify(validated.value.value.password), '"[REDACTED]"')
})

test('enroll snapshots stateful password hasher results', async () => {
  let persisted = 'hash:original'
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
  const method = createPasswordMethod({
    passwordHasher: {
      async hashPassword() {
        return {
          ok: true,
          value: {
            type: 'protected-value',
            scheme: 'password.test',
            createdAt,
            redacted: '[REDACTED]',
            revealForPersistence() {
              return persisted
            },
            toJSON() {
              return '[REDACTED]'
            }
          }
        }
      },
      async verifyPassword() {
        return { ok: true, value: { verified: false } }
      }
    }
  })
  const validated = method.operations.enroll.validate({
    subject: 'user@example.test',
    password: rawSecret('original-password')
  }, {})
  const result = await method.operations.enroll.run(validated.value.value, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    lookup: validated.value.lookup
  })

  persisted = 'hash:mutated'

  assert.equal(result.ok, true)
  assert.equal(
    result.value.credentialMaterial.privateData.passwordHash.revealForPersistence(),
    'hash:original'
  )
  assert.equal(
    JSON.stringify(result.value.credentialMaterial.privateData.passwordHash),
    '"[REDACTED]"'
  )
  assert.equal(
    result.value.credentialMaterial.privateData.passwordHash.createdAt.toISOString(),
    '2026-01-01T00:00:00.000Z'
  )
  assert.equal(createdAt.reads, 0)
})

test('rejects unsafe input and invalid constructor dependencies', () => {
  assert.throws(() => createPasswordMethod(), /hasher/)
  assert.throws(
    () => createPasswordMethod({ passwordHasher: fakePasswordHasher(), methodId: 'password' }),
    /dot-namespaced/
  )
  assert.throws(
    () => createPasswordMethod({ passwordHasher: fakePasswordHasher(), minPasswordLength: 4 }),
    /length limits/
  )
  assert.throws(
    () => createPasswordMethod({ passwordHasher: fakePasswordHasher(), subjectKind: 'email\ninjected' }),
    /safe string/
  )
  assert.throws(
    () => createPasswordMethod({ passwordHasher: fakePasswordHasher(), subjectKind: 'x'.repeat(129) }),
    /128/
  )
  const method = createPasswordMethod({ passwordHasher: fakePasswordHasher() })
  const cyclic = {}
  cyclic.self = cyclic
  const validated = method.operations.enroll.validate({
    subject: 'user@example.test',
    password: rawSecret('long-enough-secret'),
    publicData: { leaked: rawSecret('long-enough-secret') }
  }, {})
  const cyclicData = method.operations.enroll.validate({
    subject: 'user@example.test',
    password: rawSecret('long-enough-secret'),
    publicData: cyclic
  }, {})
  const disguised = method.operations.enroll.validate({
    subject: 'user@example.test',
    password: rawSecret('long-enough-secret'),
    publicData: {
      leaked: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
    }
  }, {})
  const shortPassword = method.operations.enroll.validate({
    subject: 'user@example.test',
    password: rawSecret('short')
  }, {})
  const extendedArray: unknown[] & { extra?: unknown } = []
  extendedArray.extra = { type: 'raw-secret', leak: 'must-not-cross' }
  const nonJsonData = method.operations.enroll.validate({
    subject: 'user@example.test',
    password: rawSecret('long-enough-secret'),
    publicData: { map: new Map([['key', 'value']]), extendedArray }
  }, {})

  assert.equal(validated.ok, false)
  assert.equal(validated.error.issues[0].path[0], 'publicData')
  assert.equal(cyclicData.ok, false)
  assert.equal(disguised.ok, false)
  assert.equal(nonJsonData.ok, false)
  assert.equal(shortPassword.ok, false)
  assert.equal(shortPassword.error.issues[0].path[0], 'password')
})

test('authenticate rejects mismatched password material', async () => {
  const method = createPasswordMethod({ passwordHasher: fakePasswordHasher() })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const validated = method.operations.authenticate.validate({
    subject: 'user@example.test',
    password: rawSecret('wrong-password')
  }, {})

  const result = await method.operations.authenticate.run(validated.value.value, {
    now,
    lookup: validated.value.lookup,
    identity: {
      credentialMaterial: {
        schemaVersion: 'password.v1',
        privateData: {
          passwordHash: protectedValue('hash:correct')
        }
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'PASSWORD_MISMATCH')
  assert.equal(result.error.countsAsAttempt, true)
})

test('authenticate fails closed for unknown credential material versions', async () => {
  const method = createPasswordMethod({ passwordHasher: fakePasswordHasher() })
  const validated = method.operations.authenticate.validate({
    subject: 'user@example.test',
    password: rawSecret('long-enough-secret')
  }, {})
  const result = await method.operations.authenticate.run(validated.value.value, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    lookup: validated.value.lookup,
    identity: {
      credentialMaterial: {
        schemaVersion: 'password.v2',
        privateData: { passwordHash: protectedValue('hash:long-enough-secret') }
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'CREDENTIAL_NOT_FOUND')
})

test('authenticate performs password work before rejecting a missing credential', async () => {
  let hashes = 0
  let verifications = 0
  const method = createPasswordMethod({
    passwordHasher: {
      async hashPassword(input) {
        hashes += 1
        return { ok: true, value: protectedValue(`hash:${input.password.reveal()}`) }
      },
      async verifyPassword() {
        verifications += 1
        return { ok: true, value: { verified: false } }
      }
    }
  })
  const validated = method.operations.authenticate.validate({
    subject: 'missing@example.test',
    password: rawSecret('long-enough-secret')
  }, {})

  const result = await method.operations.authenticate.run(validated.value.value, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    lookup: validated.value.lookup
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'CREDENTIAL_NOT_FOUND')
  assert.equal(result.error.countsAsAttempt, true)
  assert.equal(hashes, 1)
  assert.equal(verifications, 0)
})

test('maps thrown password hasher errors to crypto method failures', async () => {
  const method = createPasswordMethod({
    passwordHasher: {
      async hashPassword() {
        throw new Error('hash unavailable')
      },
      async verifyPassword() {
        throw new Error('verify unavailable')
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const enroll = method.operations.enroll.validate({
    subject: 'user@example.test',
    password: rawSecret('long-enough-secret')
  }, {})
  const authenticate = method.operations.authenticate.validate({
    subject: 'user@example.test',
    password: rawSecret('long-enough-secret')
  }, {})

  const enrollResult = await method.operations.enroll.run(enroll.value.value, {
    now,
    lookup: enroll.value.lookup
  })
  const authenticateResult = await method.operations.authenticate.run(authenticate.value.value, {
    now,
    lookup: authenticate.value.lookup,
    identity: {
      credentialMaterial: {
        schemaVersion: 'password.v1',
        privateData: {
          passwordHash: protectedValue('hash:secret')
        }
      }
    }
  })

  assert.equal(enrollResult.ok, false)
  assert.equal(enrollResult.error.reason, 'CRYPTO_FAILED')
  assert.equal(authenticateResult.ok, false)
  assert.equal(authenticateResult.error.reason, 'CRYPTO_FAILED')
})

test('maps malformed password hasher results to crypto failures', async () => {
  const method = createPasswordMethod({
    passwordHasher: {
      async hashPassword() {
        return { ok: true, value: {} }
      },
      async verifyPassword() {
        return { ok: true, value: {} }
      }
    }
  })
  const now = new Date('2026-01-01T00:00:00.000Z')
  const validated = method.operations.enroll.validate({
    subject: 'user@example.test',
    password: rawSecret('long-enough-secret')
  })
  const enroll = await method.operations.enroll.run(validated.value.value, {
    now,
    lookup: validated.value.lookup
  })
  const authenticate = await method.operations.authenticate.run(validated.value.value, {
    now,
    lookup: validated.value.lookup,
    identity: {
      credentialMaterial: {
        schemaVersion: 'password.v1',
        privateData: { passwordHash: protectedValue('hash') }
      }
    }
  })

  assert.equal(enroll.ok, false)
  assert.equal(enroll.error.reason, 'CRYPTO_FAILED')
  assert.equal(authenticate.ok, false)
  assert.equal(authenticate.error.reason, 'CRYPTO_FAILED')
})

test('rejects contradictory password rehash success shapes', async (t) => {
  for (const [name, value] of [
    ['missing upgraded value', { verified: true, needsRehash: true }],
    ['unexpected upgraded value', {
      verified: true,
      needsRehash: false,
      upgradedValue: protectedValue('hash:upgraded')
    }],
    ['missing rehash decision', { verified: true }]
  ]) {
    await t.test(name, async () => {
      const method = createPasswordMethod({
        passwordHasher: {
          async hashPassword(input) {
            return { ok: true, value: protectedValue(`hash:${input.password.reveal()}`) }
          },
          async verifyPassword() {
            return { ok: true, value }
          }
        }
      })
      const validated = method.operations.authenticate.validate({
        subject: 'user@example.test',
        password: rawSecret('long-enough-secret')
      }, {})
      const result = await method.operations.authenticate.run(validated.value.value, {
        now: new Date('2026-01-01T00:00:00.000Z'),
        lookup: validated.value.lookup,
        identity: {
          credentialMaterial: {
            schemaVersion: 'password.v1',
            privateData: { passwordHash: protectedValue('hash:long-enough-secret') }
          }
        }
      })

      assert.equal(result.ok, false)
      assert.equal(result.error.reason, 'CRYPTO_FAILED')
    })
  }
})

function fakePasswordHasher() {
  return {
    async hashPassword(input) {
      return { ok: true, value: protectedValue(`hash:${input.password.reveal()}`) }
    },
    async verifyPassword(input) {
      const verified = input.protectedPassword.revealForPersistence() === `hash:${input.password.reveal()}`
      return {
        ok: true,
        value: verified
          ? { verified: true, needsRehash: false }
          : { verified: false }
      }
    }
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

function protectedValue(value) {
  return {
    type: 'protected-value',
    scheme: 'password-test.v1',
    redacted: '[REDACTED]',
    revealForPersistence() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}
