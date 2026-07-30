import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuth } from '../src/index.ts'
import { dispatchSideEffects } from '../src/effects/dispatch.ts'
import { createSession } from '../src/operations/session.ts'
import { invokeMethodValidation } from '../src/method/invoke.ts'
import { generateCoreId } from '../src/shared/id.ts'
import { readNow } from '../src/shared/time.ts'
import { isStableMethodId } from '../src/validation/method.ts'
import { isRecordFailedAttemptTransition } from '../src/validation/store.ts'

test('createAuth reports required configuration fields', () => {
  const result = createAuth({})

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'CONFIG_INVALID')
  assert.deepEqual(
    result.error.details.issues.map((issue) => issue.path.join('.')).sort(),
    ['clock', 'idGenerator', 'methods', 'session.defaultTtlSeconds', 'store', 'token']
  )
})

test('createAuth rejects a non-object configuration', () => {
  const result = createAuth(null)

  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'CONFIG_INVALID')
  assert.deepEqual(result.error.details, {
    issues: [{ path: ['config'], code: 'required' }]
  })
})

test('createAuth rejects session TTLs that cannot be represented safely', () => {
  const invalidDefault = createAuth({
    ...minimalConfig(),
    session: { defaultTtlSeconds: Number.MAX_SAFE_INTEGER }
  })
  const invalidMaximum = createAuth({
    ...minimalConfig(),
    session: {
      defaultTtlSeconds: 3600,
      maxTtlSeconds: Number.MAX_SAFE_INTEGER
    }
  })

  assert.equal(invalidDefault.ok, false)
  assert.equal(invalidMaximum.ok, false)
  assert.equal(
    invalidDefault.error.details.issues.some((issue) => issue.path.join('.') === 'session.defaultTtlSeconds'),
    true
  )
  assert.equal(
    invalidMaximum.error.details.issues.some((issue) => issue.path.join('.') === 'session.maxTtlSeconds'),
    true
  )
})

test('clock snapshots Date subclasses without overridable reads', () => {
  class StatefulDate extends Date {
    reads = 0

    override getTime(): number {
      this.reads += 1
      return this.reads === 1
        ? Date.prototype.getTime.call(this)
        : Number.NaN
    }
  }
  const source = new StatefulDate('2026-01-01T00:00:00.000Z')
  const config = {
    ...minimalConfig(),
    clock: { now: () => source }
  }

  const now = readNow(config)

  assert.equal(now?.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(source.reads, 0)
})

test('id generation cannot mutate the operation timestamp', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const config = {
    ...minimalConfig(),
    idGenerator: {
      generate(input) {
        input.now.setUTCFullYear(2099)
        return 'account_1'
      }
    }
  }

  const generated = generateCoreId(config, 'account', 'tenant_1', now)

  assert.equal(generated, 'account_1')
  assert.equal(now.toISOString(), '2026-01-01T00:00:00.000Z')
})

test('method validation snapshots mutable values and raw secrets before asynchronous work', () => {
  let revealed = 'original-secret'
  const source = {
    nested: { value: 'original' },
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
  }
  const validated = invokeMethodValidation(
    () => ({ ok: true, value: { value: source } }),
    {},
    {
      method: { methodId: 'test.snapshot', methodKind: 'test' },
      auth: { tenantId: 'tenant_1' },
      now: new Date('2026-01-01T00:00:00.000Z')
    }
  )

  source.nested.value = 'mutated'
  revealed = 'mutated-secret'

  assert.equal(validated.ok, true)
  assert.equal(validated.value.value.nested.value, 'original')
  assert.equal(validated.value.value.password.reveal(), 'original-secret')
})

test('method value snapshots cover binary and persisted secret wrappers and reject unsafe object graphs', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const bytes = new Uint8Array([1, 2, 3])
  const rawBytes = new Uint8Array([4, 5, 6])
  class StatefulDate extends Date {
    reads = 0

    override getTime(): number {
      this.reads += 1
      return this.reads === 1
        ? Date.prototype.getTime.call(this)
        : Number.NaN
    }
  }
  const protectedAt = new StatefulDate('2025-12-31T23:00:00.000Z')
  const expiresAt = new StatefulDate('2026-01-01T00:05:00.000Z')
  let verifier = 'verifier'
  let ciphertext = 'ciphertext'
  const validate = (value) => invokeMethodValidation(
    () => ({ ok: true, value: { value } }),
    {},
    {
      method: { methodId: 'test.snapshot', methodKind: 'test' },
      auth: { tenantId: 'tenant_1' },
      now
    }
  )
  const valid = validate({
    now,
    bytes,
    list: [true, 42, 'value', null, undefined],
    rawBytes: {
      type: 'raw-secret',
      redacted: '[BYTES]',
      reveal: () => rawBytes,
      toJSON: () => '[BYTES]'
    },
    protected: {
      type: 'protected-value',
      scheme: 'test.v1',
      keyId: 'key_1',
      createdAt: protectedAt,
      redacted: '[HASH]',
      revealForPersistence: () => verifier,
      toJSON: () => '[HASH]'
    },
    sealed: {
      type: 'sealed-secret',
      algorithm: 'test.seal.v1',
      keyId: 'key_1',
      expiresAt,
      redacted: '[SEALED]',
      revealCiphertextForPersistence: () => ciphertext,
      toJSON: () => '[SEALED]'
    }
  })

  now.setUTCFullYear(2030)
  bytes[0] = 9
  rawBytes[0] = 9
  protectedAt.setUTCFullYear(2030)
  expiresAt.setUTCFullYear(2030)
  verifier = 'mutated-verifier'
  ciphertext = 'mutated-ciphertext'

  assert.equal(valid.ok, true)
  assert.equal(valid.value.value.now.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.deepEqual([...valid.value.value.bytes], [1, 2, 3])
  assert.deepEqual([...valid.value.value.rawBytes.reveal()], [4, 5, 6])
  assert.equal(valid.value.value.protected.revealForPersistence(), 'verifier')
  assert.equal(valid.value.value.protected.createdAt.toISOString(), '2025-12-31T23:00:00.000Z')
  assert.equal(valid.value.value.sealed.revealCiphertextForPersistence(), 'ciphertext')
  assert.equal(valid.value.value.sealed.expiresAt.toISOString(), '2026-01-01T00:05:00.000Z')
  assert.equal(protectedAt.reads, 0)
  assert.equal(expiresAt.reads, 0)

  const cyclic = {}
  cyclic.self = cyclic
  const sparse = []
  sparse[1] = 'value'
  const extended = ['value']
  extended.extra = true
  let accessorReads = 0
  const accessor = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      accessorReads += 1
      return 'must-not-cross'
    }
  })
  const nonEnumerable = {}
  Object.defineProperty(nonEnumerable, 'hidden', {
    enumerable: false,
    value: 'must-not-cross'
  })
  const symbolKey = { [Symbol('hidden')]: 'must-not-cross' }
  let deep = {}
  for (let depth = 0; depth < 34; depth += 1) deep = { nested: deep }
  const invalidValues = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Symbol('invalid'),
    new Date('invalid'),
    new Uint8Array(1_000_001),
    'x'.repeat(1_000_001),
    cyclic,
    sparse,
    extended,
    new Map(),
    { '': true },
    { ['x'.repeat(513)]: true },
    accessor,
    nonEnumerable,
    symbolKey,
    deep,
    Array.from({ length: 10_001 }, () => null),
    {
      type: 'raw-secret',
      redacted: '[REDACTED]',
      reveal: () => '',
      toJSON: () => '[REDACTED]'
    },
    {
      type: 'raw-secret',
      redacted: '[REDACTED]',
      reveal: () => new Uint8Array(),
      toJSON: () => '[REDACTED]'
    },
    {
      type: 'protected-value',
      scheme: 'test.v1',
      redacted: '[HASH]',
      revealForPersistence: () => '',
      toJSON: () => '[HASH]'
    },
    {
      type: 'sealed-secret',
      algorithm: 'test.seal.v1',
      keyId: 'key_1',
      redacted: '[SEALED]',
      revealCiphertextForPersistence() {
        throw new Error('ciphertext getter failed')
      },
      toJSON: () => '[SEALED]'
    }
  ]

  for (const value of invalidValues) {
    assert.equal(validate(value).ok, false)
  }
  assert.equal(accessorReads, 0)
})

test('challenge failed-attempt acknowledgements must prove a monotonic transition', () => {
  const now = new Date('2026-01-01T00:00:01.000Z')
  const previous = {
    tenantId: 'tenant_1',
    challengeId: 'challenge_1',
    methodId: 'otp.email',
    methodKind: 'otp',
    status: 'pending',
    material: { schemaVersion: 'otp.v1' },
    binding: { account: { mode: 'require-existing-identity' } },
    attempts: 0,
    maxAttempts: 3,
    version: 1,
    expiresAt: new Date('2026-01-01T00:05:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z')
  }
  const unchanged = {
    status: 'recorded',
    challenge: { ...previous, updatedAt: now }
  }
  const advanced = {
    status: 'recorded',
    challenge: {
      ...previous,
      attempts: 1,
      version: 2,
      updatedAt: now
    }
  }

  assert.equal(isRecordFailedAttemptTransition(previous, unchanged, now), false)
  assert.equal(isRecordFailedAttemptTransition(previous, advanced, now), true)
})

test('createAuth rejects non-contract configuration shape', () => {
  const result = createAuth({
    ...minimalConfig(),
    carrier: {},
    clock: {},
    idGenerator: {},
    methods: {
      password: {
        methodId: 'password',
        methodKind: 'password',
        operations: {}
      }
    }
  })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.error.details.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).sort(),
    [
      'carrier:not-allowed-in-core-config',
      'clock:required',
      'idGenerator:required',
      'methods.password.methodId:stable-dot-namespace-required'
    ]
  )
})

test('core method identifiers use the ecosystem-wide 128-character limit', () => {
  assert.equal(isStableMethodId(`a.${'b'.repeat(126)}`), true)
  assert.equal(isStableMethodId(`a.${'b'.repeat(127)}`), false)
})

test('getSession resolves an active session through token hash lookup', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date('2026-01-01T01:00:00.000Z')
  const tokenHash = protectedValue('hash:token')

  const authResult = createAuth({
    methods: {},
    clock: {
      now() {
        return now
      }
    },
    idGenerator: {
      generate() {
        return 'unused'
      }
    },
    session: {
      defaultTtlSeconds: 3600
    },
    token: {
      async identify(input) {
        assert.equal(input.expectedTenantId, 'tenant_1')
        assert.equal(input.raw.reveal(), 'token')
        return { ok: true, value: { kind: 'by-token-hash', tokenHash } }
      },
      async issue() {
        throw new Error('issue should not be called')
      }
    },
    store: validStore({
      durable: {
        accounts: {
          async findById() {
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                accountId: 'account_1',
                status: 'active',
                createdAt: now,
                updatedAt: now
              }
            }
          }
        }
      },
      session: {
        sessions: {
          async findById() {
            throw new Error('findById should not be called')
          },
          async findByTokenHash(input) {
            assert.equal(input.tenantId, 'tenant_1')
            assert.notEqual(input.tokenHash, tokenHash)
            assert.equal(input.tokenHash.redacted, '[REDACTED]')
            assert.equal(input.tokenHash.toJSON(), '[REDACTED]')
            assert.equal(input.tokenHash.revealForPersistence(), 'hash:token')
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                sessionId: 'session_1',
                accountId: 'account_1',
                tokenHash,
                status: 'active',
                issuedAt: now,
                expiresAt,
                createdAt: now,
                updatedAt: now
              }
            }
          }
        }
      }
    })
  })

  assert.equal(authResult.ok, true)

  const result = await authResult.value.getSession({
    context: { tenantId: 'tenant_1' },
    token: rawSecret('token')
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    tenantId: 'tenant_1',
    sessionId: 'session_1',
    accountId: 'account_1',
    status: 'active',
    issuedAt: now,
    expiresAt,
    revokedAt: undefined
  })
})

test('getSession rechecks expiry after asynchronous collaborators finish', async () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date(startedAt.getTime() + 1000)
  let clockNow = startedAt
  const tokenHash = protectedValue('hash:token')
  const authResult = createAuth({
    ...minimalConfig({ now: startedAt }),
    clock: {
      now() {
        return clockNow
      }
    },
    token: {
      async identify() {
        clockNow = new Date(expiresAt.getTime() + 1)
        return { ok: true, value: { kind: 'by-token-hash', tokenHash } }
      },
      async issue() {
        throw new Error('issue should not be called')
      }
    },
    store: validStore({
      durable: {
        accounts: {
          async findById() {
            return {
              ok: true,
              value: accountRecord(startedAt)
            }
          }
        }
      },
      session: {
        sessions: {
          async findByTokenHash() {
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                sessionId: 'session_1',
                accountId: 'account_1',
                tokenHash,
                status: 'active',
                issuedAt: startedAt,
                expiresAt,
                createdAt: startedAt,
                updatedAt: startedAt
              }
            }
          }
        }
      }
    })
  })

  const result = await authResult.value.getSession({
    context: { tenantId: 'tenant_1' },
    token: rawSecret('token')
  })

  assert.deepEqual(result, { ok: true, value: null })
})

test('getSession returns null when token is missing', async () => {
  const authResult = createAuth(minimalConfig())

  assert.equal(authResult.ok, true)
  assert.deepEqual(await authResult.value.getSession({ context: { tenantId: 'tenant_1' } }), {
    ok: true,
    value: null
  })
  assert.deepEqual(await authResult.value.getSession({
    context: { tenantId: 'tenant_1', actor: { type: 'system', name: 'session-cleanup' } }
  }), {
    ok: true,
    value: null
  })
})

test('getSession treats throwing, malformed, and failed token adapters as unavailable', async (t) => {
  const cases = [
    {
      name: 'throwing adapter',
      expectedReason: 'INTERNAL',
      identify() {
        throw new Error('private token failure')
      }
    },
    {
      name: 'malformed success',
      expectedReason: 'INTERNAL',
      async identify() {
        return { ok: true, value: { kind: 'by-token-hash', tokenHash: {} } }
      }
    },
    {
      name: 'component failure',
      expectedReason: 'CRYPTO_FAILED',
      async identify() {
        return {
          ok: false,
          error: {
            type: 'component.failure',
            component: 'token',
            reason: 'CRYPTO_FAILED'
          }
        }
      }
    }
  ]

  for (const current of cases) {
    await t.test(current.name, async () => {
      const authResult = createAuth({
        ...minimalConfig(),
        token: {
          identify: current.identify,
          async issue() {
            throw new Error('issue should not run')
          }
        }
      })
      const result = await authResult.value.getSession({
        context: { tenantId: 'tenant_1' },
        token: rawSecret('token')
      })

      assert.equal(result.ok, false)
      assert.equal(result.error.internalReason, current.expectedReason)
      assert.equal(result.error.publicError.code, 'TEMPORARILY_UNAVAILABLE')
    })
  }
})

test('getSession rejects by-session tenant and token-hash mismatches', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date('2026-01-01T01:00:00.000Z')
  const storedHash = protectedValue('stored-hash')
  let identified = {
    kind: 'by-session',
    tenantId: 'tenant_other',
    sessionId: 'session_1',
    tokenHash: storedHash
  }
  let sessionLookups = 0
  const authResult = createAuth({
    ...minimalConfig({ now }),
    token: {
      async identify() {
        return { ok: true, value: identified }
      },
      async issue() {
        throw new Error('issue should not be called')
      }
    },
    store: validStore({
      durable: {
        accounts: {
          async findById() {
            return { ok: true, value: accountRecord(now) }
          }
        }
      },
      session: {
        sessions: {
          async findById() {
            sessionLookups += 1
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                sessionId: 'session_1',
                accountId: 'account_1',
                tokenHash: storedHash,
                status: 'active',
                issuedAt: now,
                expiresAt,
                createdAt: now,
                updatedAt: now
              }
            }
          }
        }
      }
    })
  })

  const auth = authResult.value
  const input = { context: { tenantId: 'tenant_1' }, token: rawSecret('token') }
  assert.deepEqual(await auth.getSession(input), { ok: true, value: null })
  assert.equal(sessionLookups, 0)

  identified = {
    kind: 'by-session',
    tenantId: 'tenant_1',
    sessionId: 'session_1',
    tokenHash: protectedValue('different-hash')
  }
  assert.deepEqual(await auth.getSession(input), { ok: true, value: null })
  assert.equal(sessionLookups, 1)
})

test('getSession rejects cross-tenant and non-literal session store records', async (t) => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const tokenHash = protectedValue('hash:token')
  const baseRecord = {
    tenantId: 'tenant_1',
    sessionId: 'session_1',
    accountId: 'account_1',
    tokenHash,
    status: 'active',
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 3600000),
    createdAt: now,
    updatedAt: now
  }
  const records = [
    { name: 'foreign tenant', value: { ...baseRecord, tenantId: 'tenant_other' } },
    {
      name: 'coercible status object',
      value: {
        ...baseRecord,
        status: { toString: () => 'active' }
      }
    }
  ]

  for (const current of records) {
    await t.test(current.name, async () => {
      const authResult = createAuth({
        ...minimalConfig({ now }),
        token: {
          async identify() {
            return { ok: true, value: { kind: 'by-token-hash', tokenHash } }
          },
          async issue() {
            throw new Error('issue should not run')
          }
        },
        store: validStore({
          session: {
            sessions: {
              async findByTokenHash() {
                return { ok: true, value: current.value }
              }
            }
          }
        })
      })
      const result = await authResult.value.getSession({
        context: { tenantId: 'tenant_1' },
        token: rawSecret('token')
      })

      assert.equal(result.ok, false)
      assert.equal(result.error.internalReason, 'INTERNAL')
      assert.equal(result.error.publicError.code, 'TEMPORARILY_UNAVAILABLE')
    })
  }
})

test('getSession rejects active sessions owned by disabled accounts', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const tokenHash = protectedValue('hash')
  const authResult = createAuth({
    ...minimalConfig({ now }),
    token: {
      async identify() {
        return { ok: true, value: { kind: 'by-token-hash', tokenHash } }
      },
      async issue() {
        throw new Error('issue should not be called')
      }
    },
    store: validStore({
      durable: {
        accounts: {
          async findById() {
            return { ok: true, value: { ...accountRecord(now), status: 'disabled' } }
          }
        }
      },
      session: {
        sessions: {
          async findByTokenHash() {
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                sessionId: 'session_1',
                accountId: 'account_1',
                tokenHash,
                status: 'active',
                issuedAt: now,
                expiresAt: new Date(now.getTime() + 3600000),
                createdAt: now,
                updatedAt: now
              }
            }
          }
        }
      }
    })
  })

  assert.deepEqual(await authResult.value.getSession({
    context: { tenantId: 'tenant_1' },
    token: rawSecret('token')
  }), { ok: true, value: null })
})

test('revokeSession is non-enumerating for missing sessions', async () => {
  const calls = []
  const authResult = createAuth({
    ...minimalConfig(),
    policy(check) {
      calls.push(check)
      return { allow: false, reason: 'POLICY_DENIED' }
    },
    store: validStore({
      session: {
        sessions: {
          async findById(input) {
            assert.equal(input.sessionId, 'missing_session')
            return { ok: true, value: null }
          },
          async revoke(input) {
            calls.push({ kind: 'revoke', input })
            return { ok: true, value: null }
          }
        }
      }
    })
  })

  assert.equal(authResult.ok, true)

  const result = await authResult.value.revokeSession({
    context: { tenantId: 'tenant_1' },
    sessionId: 'missing_session'
  })

  assert.deepEqual(result, { ok: true, value: undefined })
  assert.deepEqual(calls, [])
})

test('revokeSession does not revoke a session owned by another account actor', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let revocations = 0
  const record = {
    tenantId: 'tenant_1',
    sessionId: 'session_1',
    accountId: 'account_owner',
    tokenHash: protectedValue('hash:token'),
    status: 'active',
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 3600000),
    createdAt: now,
    updatedAt: now
  }
  const authResult = createAuth({
    ...minimalConfig({ now }),
    store: validStore({
      session: {
        sessions: {
          async findById() {
            return { ok: true, value: record }
          },
          async revoke() {
            revocations += 1
            return {
              ok: true,
              value: { ...record, status: 'revoked', revokedAt: now, updatedAt: now }
            }
          }
        }
      }
    })
  })

  const foreign = await authResult.value.revokeSession({
    context: {
      tenantId: 'tenant_1',
      actor: { type: 'account', accountId: 'account_attacker' }
    },
    sessionId: 'session_1'
  })
  const owner = await authResult.value.revokeSession({
    context: {
      tenantId: 'tenant_1',
      actor: { type: 'account', accountId: 'account_owner' }
    },
    sessionId: 'session_1'
  })

  assert.deepEqual(foreign, { ok: true, value: undefined })
  assert.deepEqual(owner, { ok: true, value: undefined })
  assert.equal(revocations, 1)
})

test('revokeSession does not reveal missing versus foreign sessions through policy denial', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const foreignRecord = {
    tenantId: 'tenant_1',
    sessionId: 'foreign_session',
    accountId: 'account_owner',
    tokenHash: protectedValue('hash:token'),
    status: 'active',
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 3600000),
    createdAt: now,
    updatedAt: now
  }
  let policyCalls = 0
  const authResult = createAuth({
    ...minimalConfig({ now }),
    policy() {
      policyCalls += 1
      return { allow: false, reason: 'POLICY_DENIED' }
    },
    store: validStore({
      session: {
        sessions: {
          async findById({ sessionId }) {
            return {
              ok: true,
              value: sessionId === foreignRecord.sessionId ? foreignRecord : null
            }
          },
          async revoke() {
            throw new Error('must not revoke missing or foreign sessions')
          }
        }
      }
    })
  })
  const context = {
    tenantId: 'tenant_1',
    actor: { type: 'account', accountId: 'account_attacker' }
  }

  const missing = await authResult.value.revokeSession({
    context,
    sessionId: 'missing_session'
  })
  const foreign = await authResult.value.revokeSession({
    context,
    sessionId: 'foreign_session'
  })

  assert.deepEqual(missing, { ok: true, value: undefined })
  assert.deepEqual(foreign, { ok: true, value: undefined })
  assert.equal(policyCalls, 0)
})

test('enroll rejects proof binding mismatch before creating records', async () => {
  const calls = []
  const lookup = {
    methodId: 'password.email',
    methodKind: 'password',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const authResult = createAuth({
    ...minimalConfig(),
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          enroll: {
            validate() {
              calls.push('validate')
              return { ok: true, value: { value: {}, lookup } }
            },
            async run(input, context) {
              calls.push('run')
              return {
                ok: true,
                value: {
                  identity: { ...lookup, verifiedAt: context.now },
                  proof: {
                    type: 'auth.proof',
                    proofMethod: { methodId: 'otp.email', methodKind: 'otp' },
                    primaryIdentity: { ...lookup, verifiedAt: context.now },
                    evidence: [],
                    authTime: context.now
                  }
                }
              }
            }
          }
        }
      }
    },
    guard: {
      async beforeAttempt() {
        calls.push('beforeAttempt')
        return { ok: true, value: { allow: true } }
      },
      async afterAttempt(input) {
        calls.push(`afterAttempt:${input.outcome.reason}`)
        return { ok: true, value: undefined }
      }
    },
    policy(check) {
      calls.push(`policy:${check.kind}`)
      return { allow: true }
    },
    store: validStore({
      durable: {
        identities: {
          async create() {
            throw new Error('identity create should not run')
          }
        },
        accounts: {
          async create() {
            throw new Error('account create should not run')
          }
        },
        credentials: {
          async create() {
            throw new Error('credential create should not run')
          }
        }
      },
      session: {
        sessions: {}
      }
    })
  })

  assert.equal(authResult.ok, true)

  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'IDENTITY_BINDING_MISMATCH')
  assert.deepEqual(calls, [
    'validate',
    'beforeAttempt',
    'policy:start-attempt',
    'run',
    'afterAttempt:IDENTITY_BINDING_MISMATCH'
  ])
})

test('enroll rejects account modes that could attach credentials to an unrelated existing identity', async () => {
  let validated = false
  const authResult = createAuth({
    ...minimalConfig(),
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          enroll: {
            validate() {
              validated = true
              return { ok: false, error: { type: 'validation.failure', issues: [] } }
            },
            async run() {
              throw new Error('run should not be called')
            }
          }
        }
      }
    }
  })

  assert.equal(authResult.ok, true)
  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'require-existing-identity' },
    session: {}
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'VALIDATION_FAILED')
  assert.equal(result.error.publicError.code, 'INVALID_INPUT')
  assert.equal(validated, false)
})

test('enroll rejects identity claims from a different method without a lookup', async () => {
  const authResult = createAuth({
    ...minimalConfig(),
    methods: {
      'otp.email': {
        methodId: 'otp.email',
        methodKind: 'otp',
        operations: {
          enroll: {
            validate() {
              return { ok: true, value: { value: {} } }
            },
            async run(input, context) {
              return {
                ok: true,
                value: {
                  identity: {
                    methodId: 'password.email',
                    methodKind: 'password',
                    subject: 'user@example.test',
                    subjectKind: 'email',
                    verifiedAt: context.now
                  }
                }
              }
            }
          }
        }
      }
    }
  })

  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'IDENTITY_BINDING_MISMATCH')
})

test('enroll rejects secret-bearing method output publicData', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let publicData = { secret: rawSecret('must-not-cross') }
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          enroll: {
            validate() {
              return { ok: true, value: { value: {} } }
            },
            async run() {
              return {
                ok: true,
                value: {
                  identity: {
                    methodId: 'password.email',
                    methodKind: 'password',
                    subject: 'user@example.test',
                    subjectKind: 'email'
                  },
                  publicData
                }
              }
            }
          }
        }
      }
    }
  })

  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })
  publicData = {
    secret: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
  }
  const disguised = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'VALIDATION_FAILED')
  assert.equal(result.error.publicError.code, 'INVALID_INPUT')
  assert.equal(disguised.ok, false)
  assert.equal(disguised.error.internalReason, 'VALIDATION_FAILED')
})

test('enroll converts throwing method validators and runners to safe failures', async () => {
  let phase = 'validate'
  const authResult = createAuth({
    ...minimalConfig(),
    methods: {
      'test.throwing': {
        methodId: 'test.throwing',
        methodKind: 'test',
        operations: {
          enroll: {
            validate() {
              if (phase === 'validate') throw new Error('private validator failure')
              return { ok: true, value: { value: {} } }
            },
            async run() {
              throw new Error('private runner failure')
            }
          }
        }
      }
    }
  })
  const input = {
    context: { tenantId: 'tenant_1' },
    methodId: 'test.throwing',
    input: {},
    account: { mode: 'create-new-account' }
  }

  const validationFailure = await authResult.value.enroll(input)
  phase = 'run'
  const runnerFailure = await authResult.value.enroll(input)

  assert.equal(validationFailure.ok, false)
  assert.equal(validationFailure.error.internalReason, 'VALIDATION_FAILED')
  assert.equal(runnerFailure.ok, false)
  assert.equal(runnerFailure.error.internalReason, 'INTERNAL')
  assert.equal(runnerFailure.error.publicError.code, 'INTERNAL')
})

test('core propagates custom method attempt-counting semantics to the guard', async () => {
  const outcomes = []
  const authResult = createAuth({
    ...minimalConfig(),
    methods: {
      'custom.email': {
        methodId: 'custom.email',
        methodKind: 'custom',
        operations: {
          enroll: {
            validate() {
              return { ok: true, value: { value: {} } }
            },
            async run() {
              return {
                ok: false,
                error: {
                  type: 'component.failure',
                  component: 'method',
                  reason: 'custom.invalid-secret',
                  countsAsAttempt: true
                }
              }
            }
          }
        }
      }
    },
    guard: {
      async beforeAttempt() {
        return { ok: true, value: { allow: true } }
      },
      async afterAttempt(input) {
        outcomes.push(input.outcome)
        return { ok: true, value: undefined }
      }
    }
  })

  assert.equal(authResult.ok, true)
  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'custom.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'custom.invalid-secret')
  assert.deepEqual(outcomes, [{
    success: false,
    reason: 'custom.invalid-secret',
    countsAsAttempt: true
  }])
})

test('enroll rejects nested secret-bearing credential material before persistence', async () => {
  const authResult = createAuth({
    ...minimalConfig(),
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          enroll: {
            validate() {
              return { ok: true, value: { value: {} } }
            },
            async run() {
              return {
                ok: true,
                value: {
                  identity: {
                    methodId: 'password.email',
                    methodKind: 'password',
                    subject: 'user@example.test',
                    subjectKind: 'email'
                  },
                  credentialMaterial: {
                    schemaVersion: 'password.v1',
                    privateData: {
                      nested: { passwordHash: protectedValue('hash') }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  })

  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'VALIDATION_FAILED')
  assert.equal(result.error.publicError.code, 'INVALID_INPUT')
})

test('begin fails missing required identity before challenge delivery', async () => {
  const calls = []
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const authResult = createAuth(beginConfig({
    calls,
    method: challengeMethod({
      calls,
      lookup,
      run() {
        throw new Error('method begin should not run')
      }
    }),
    identities: {
      async findBySubject(input) {
        calls.push('findBySubject')
        assert.equal(input.subject, 'user@example.test')
        return { ok: true, value: null }
      }
    },
    guard: {
      async beforeAttempt() {
        throw new Error('guard should not run')
      },
      async afterAttempt() {
        throw new Error('guard should not run')
      }
    },
    policy() {
      throw new Error('policy should not run')
    }
  }))

  assert.equal(authResult.ok, true)

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: { subject: 'user@example.test' },
    account: { mode: 'require-existing-identity' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'AUTHENTICATION_FAILED')
  assert.equal(result.error.publicError.code, 'CHALLENGE_FAILED')
  assert.deepEqual(calls, ['validate', 'findBySubject'])
})

test('begin fails closed for malformed guard and policy decisions', async () => {
  const input = {
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-new-account' }
  }
  const malformedGuard = createAuth(beginConfig({
    method: challengeMethod({ calls: [], lookup: undefined }),
    guard: {
      async beforeAttempt() {
        return { ok: true, value: { allow: 'yes' } }
      },
      async afterAttempt() {
        return { ok: true, value: undefined }
      }
    }
  }))
  const malformedPolicy = createAuth(beginConfig({
    method: challengeMethod({ calls: [], lookup: undefined }),
    policy() {
      return { allow: 'yes' }
    }
  }))

  const guardResult = await malformedGuard.value.begin(input)
  const policyResult = await malformedPolicy.value.begin(input)

  assert.equal(guardResult.ok, false)
  assert.equal(guardResult.error.internalReason, 'INTERNAL')
  assert.equal(guardResult.error.publicError.code, 'TEMPORARILY_UNAVAILABLE')
  assert.equal(policyResult.ok, false)
  assert.equal(policyResult.error.internalReason, 'INTERNAL')
  assert.equal(policyResult.error.publicError.code, 'TEMPORARILY_UNAVAILABLE')
})

test('begin rejects invalid challenge output before storing', async () => {
  const calls = []
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const now = new Date('2026-01-01T00:00:00.000Z')
  const authResult = createAuth(beginConfig({
    calls,
    now,
    method: challengeMethod({
      calls,
      lookup,
      run(input, context) {
        return {
          ok: true,
          value: {
            challengeMaterial: { schemaVersion: '' },
            expiresAt: context.now,
            maxAttempts: 0,
            sideEffects: []
          }
        }
      }
    }),
    identities: {
      async findBySubject() {
        calls.push('findBySubject')
        return { ok: true, value: null }
      }
    },
    guard: {
      async beforeAttempt() {
        calls.push('guard')
        return { ok: true, value: { allow: true } }
      },
      async afterAttempt(input) {
        calls.push(`afterAttempt:${input.outcome.reason}`)
        return { ok: true, value: undefined }
      }
    },
    policy(check) {
      calls.push(`policy:${check.kind}`)
      return { allow: true }
    }
  }))

  assert.equal(authResult.ok, true)

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: { subject: 'user@example.test' },
    account: { mode: 'create-account-if-identity-missing' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'VALIDATION_FAILED')
  assert.deepEqual(calls, [
    'validate',
    'findBySubject',
    'guard',
    'policy:start-attempt',
    'run',
    'afterAttempt:VALIDATION_FAILED'
  ])
})

test('begin runs account preflight before guard and policy', async () => {
  const calls = []
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const now = new Date('2026-01-01T00:00:00.000Z')
  const authResult = createAuth(beginConfig({
    calls,
    now,
    method: challengeMethod({ calls, lookup }),
    identities: {
      async findBySubject() {
        calls.push('findBySubject')
        return { ok: true, value: null }
      }
    },
    challenges: {
      async create(input) {
        calls.push('createChallenge')
        assert.equal(input.record.challengeId, 'challenge_1')
        return { ok: true, value: input.record }
      }
    },
    guard: {
      async beforeAttempt() {
        calls.push('guard')
        return { ok: true, value: { allow: true } }
      },
      async afterAttempt() {
        calls.push('afterAttempt')
        return { ok: true, value: undefined }
      }
    },
    policy(check) {
      calls.push(`policy:${check.kind}`)
      return { allow: true }
    }
  }))

  assert.equal(authResult.ok, true)

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: { subject: 'user@example.test' },
    account: { mode: 'create-account-if-identity-missing' }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    challengeId: 'challenge_1',
    expiresAt: new Date(now.getTime() + 300000),
    publicData: { flow: 'otp' }
  })
  assert.deepEqual(calls, [
    'validate',
    'findBySubject',
    'guard',
    'policy:start-attempt',
    'run',
    'createChallenge',
    'afterAttempt'
  ])
})

test('complete maps counted attempt terminal result and runs afterAttempt once', async () => {
  const calls = []
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'otp.email': {
        methodId: 'otp.email',
        methodKind: 'otp',
        operations: {
          complete: {
            validate() {
              calls.push('validate')
              return { ok: true, value: { value: {}, lookup } }
            },
            async run() {
              calls.push('run')
              return {
                ok: false,
                error: {
                  type: 'component.failure',
                  component: 'method',
                  reason: 'OTP_MISMATCH',
                  countsAsAttempt: true,
                  safePublicCodeHint: 'CHALLENGE_FAILED'
                }
              }
            }
          }
        }
      }
    },
    guard: {
      async beforeAttempt() {
        calls.push('beforeAttempt')
        return { ok: true, value: { allow: true } }
      },
      async afterAttempt(input) {
        calls.push(`afterAttempt:${input.outcome.reason}`)
        return { ok: true, value: undefined }
      }
    },
    policy(check) {
      calls.push(`policy:${check.kind}`)
      return { allow: true }
    },
    store: validStore({
      durable: {
        accounts: {},
        identities: {},
        credentials: {}
      },
      session: {
        sessions: {}
      },
      ephemeral: {
        challenges: {
          async findById() {
            calls.push('findChallenge')
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                challengeId: 'challenge_1',
                methodId: 'otp.email',
                methodKind: 'otp',
                lookup,
                status: 'pending',
                material: { schemaVersion: 'otp.v1' },
                binding: { account: { mode: 'require-existing-identity' } },
                attempts: 2,
                maxAttempts: 3,
                version: 1,
                expiresAt: new Date(now.getTime() + 300000),
                createdAt: now,
                updatedAt: now
              }
            }
          },
          async recordFailedAttempt() {
            calls.push('recordFailedAttempt')
            return {
              ok: true,
              value: {
                status: 'attempts-exceeded',
                challenge: {
                  tenantId: 'tenant_1',
                  challengeId: 'challenge_1',
                  methodId: 'otp.email',
                  methodKind: 'otp',
                  lookup,
                  status: 'failed',
                  material: { schemaVersion: 'otp.v1' },
                  binding: { account: { mode: 'require-existing-identity' } },
                  attempts: 3,
                  maxAttempts: 3,
                  version: 2,
                  expiresAt: new Date(now.getTime() + 300000),
                  createdAt: now,
                  updatedAt: now
                }
              }
            }
          }
        }
      }
    })
  })

  assert.equal(authResult.ok, true)

  const result = await authResult.value.complete({
    context: { tenantId: 'tenant_1' },
    challengeId: 'challenge_1',
    input: {}
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'CHALLENGE_ATTEMPTS_EXCEEDED')
  assert.equal(result.error.publicError.code, 'CHALLENGE_FAILED')
  assert.deepEqual(calls, [
    'findChallenge',
    'validate',
    'beforeAttempt',
    'policy:start-attempt',
    'run',
    'recordFailedAttempt',
    'afterAttempt:CHALLENGE_ATTEMPTS_EXCEEDED'
  ])
})

test('public methods map malformed input to INVALID_INPUT instead of INTERNAL', async () => {
  const authResult = createAuth(minimalConfig())
  const cyclic = {}
  cyclic.self = cyclic
  const extendedArray: unknown[] & { extra?: unknown } = []
  extendedArray.extra = { type: 'raw-secret', leak: 'must-not-cross' }

  const result = await authResult.value.authenticate(undefined)
  const cyclicMetadata = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1', metadata: cyclic },
    methodId: 'password.email',
    input: {}
  })
  const oversizedTenant = await authResult.value.authenticate({
    context: { tenantId: 'x'.repeat(513) },
    methodId: 'password.email',
    input: {}
  })
  const extraContextSecret = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1', secret: { reveal() { return 'private' } } },
    methodId: 'password.email',
    input: {}
  })
  const nonJsonMetadata = await authResult.value.authenticate({
    context: {
      tenantId: 'tenant_1',
      metadata: {
        bytes: new Uint8Array([1, 2]),
        map: new Map([['key', 'value']]),
        extendedArray
      }
    },
    methodId: 'password.email',
    input: {}
  })
  const extraSessionField = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    session: { ttlSeconds: 60, policyInput: { elevated: true } }
  })
  const extraAccountField = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-new-account', policyInput: { elevated: true } }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'VALIDATION_FAILED')
  assert.equal(result.error.publicError.code, 'INVALID_INPUT')
  assert.equal(cyclicMetadata.error.publicError.code, 'INVALID_INPUT')
  assert.equal(oversizedTenant.error.publicError.code, 'INVALID_INPUT')
  assert.equal(extraContextSecret.error.publicError.code, 'INVALID_INPUT')
  assert.equal(nonJsonMetadata.error.publicError.code, 'INVALID_INPUT')
  assert.equal(extraSessionField.error.publicError.code, 'INVALID_INPUT')
  assert.equal(extraAccountField.error.publicError.code, 'INVALID_INPUT')
})

test('begin passes one transaction context to challenge storage and outbox dispatch and rolls back failure', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  let challengeCreated = false
  let transactionContext
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'otp.email': challengeMethod({
        calls: [],
        lookup,
        run(input, context) {
          return {
            ok: true,
            value: {
              challengeMaterial: { schemaVersion: 'otp.v1' },
              expiresAt: new Date(context.now.getTime() + 300000),
              maxAttempts: 3,
              sideEffects: [{
                type: 'delivery',
                dispatchPolicy: 'required',
                idempotencyKey: 'begin-rollback',
                message: { to: { channel: 'email', target: lookup.subject }, templateId: 'otp' }
              }]
            }
          }
        }
      })
    },
    effects: {
      transactionScopes: ['outbox'],
      async dispatch(input) {
        assert.equal(input.tx, transactionContext)
        return {
          ok: false,
          error: { type: 'component.failure', component: 'effects', reason: 'SIDE_EFFECT_FAILED' }
        }
      }
    },
    store: validStore({
      durable: {
        identities: {
          async findBySubject() {
            return { ok: true, value: null }
          }
        },
        accounts: {},
        credentials: {}
      },
      session: { sessions: {} },
      ephemeral: {
        challenges: {
          async create(input, tx) {
            assert.equal(tx, transactionContext)
            challengeCreated = true
            return { ok: true, value: input.record }
          }
        }
      },
      transaction: {
        async run(_request, fn) {
          const before = challengeCreated
          transactionContext = { transactionId: 'tx_1', covers: ['challenges', 'outbox'] }
          const result = await fn(transactionContext)
          if (!result.ok) challengeCreated = before
          return result
        }
      }
    })
  })

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-account-if-identity-missing' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'SIDE_EFFECT_FAILED')
  assert.equal(challengeCreated, false)
})

test('begin rejects incomplete required dispatch results and rolls back persistence', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  let challengeCreated = false
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'otp.email': challengeMethod({
        calls: [],
        lookup,
        run(input, context) {
          return {
            ok: true,
            value: {
              challengeMaterial: { schemaVersion: 'otp.v1' },
              expiresAt: new Date(context.now.getTime() + 300000),
              maxAttempts: 3,
              sideEffects: [{
                type: 'delivery',
                dispatchPolicy: 'required',
                idempotencyKey: 'begin-incomplete-dispatch',
                message: { to: { channel: 'email', target: lookup.subject }, templateId: 'otp' }
              }]
            }
          }
        }
      })
    },
    effects: {
      transactionScopes: ['outbox'],
      async dispatch() {
        return { ok: true, value: { dispatched: [] } }
      }
    },
    store: validStore({
      ephemeral: {
        challenges: {
          async create(input) {
            challengeCreated = true
            return { ok: true, value: input.record }
          }
        }
      },
      transaction: {
        async run(_request, fn) {
          const before = challengeCreated
          const result = await fn({ transactionId: 'tx_1', covers: ['challenges', 'outbox'] })
          if (!result.ok) challengeCreated = before
          return result
        }
      }
    })
  })

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-account-if-identity-missing' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'SIDE_EFFECT_FAILED')
  assert.equal(challengeCreated, false)
})

test('begin rejects required effects before persistence without a transaction', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  let challengeCreates = 0
  let dispatches = 0
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'otp.email': challengeMethod({
        calls: [],
        lookup,
        run(input, context) {
          return {
            ok: true,
            value: {
              challengeMaterial: { schemaVersion: 'otp.v1' },
              expiresAt: new Date(context.now.getTime() + 300000),
              maxAttempts: 3,
              sideEffects: [{
                type: 'delivery',
                dispatchPolicy: 'required',
                idempotencyKey: 'begin-no-transaction',
                message: { to: { channel: 'email', target: lookup.subject }, templateId: 'otp' }
              }]
            }
          }
        }
      })
    },
    effects: {
      transactionScopes: ['outbox'],
      async dispatch() {
        dispatches += 1
        return { ok: true, value: { dispatched: [{ index: 0, type: 'delivery' }] } }
      }
    },
    store: validStore({
      transaction: undefined,
      ephemeral: {
        challenges: {
          async create(input) {
            challengeCreates += 1
            return { ok: true, value: input.record }
          }
        }
      }
    })
  })

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-account-if-identity-missing' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'SIDE_EFFECT_FAILED')
  assert.equal(challengeCreates, 0)
  assert.equal(dispatches, 0)
})

test('best-effort outbox effects run after the auth-state transaction commits', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  let dispatchHadNoTransaction = false
  let dispatchAfterCommit = false
  let committed = false
  let requestedScopes
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'otp.email': challengeMethod({
        calls: [],
        lookup,
        run(input, context) {
          return {
            ok: true,
            value: {
              challengeMaterial: { schemaVersion: 'otp.v1' },
              expiresAt: new Date(context.now.getTime() + 300000),
              maxAttempts: 3,
              sideEffects: [{
                type: 'delivery',
                dispatchPolicy: 'best-effort',
                message: { to: { channel: 'email', target: lookup.subject }, templateId: 'otp' }
              }]
            }
          }
        }
      })
    },
    effects: {
      transactionScopes: ['outbox'],
      async dispatch(input) {
        dispatchHadNoTransaction = input.tx === undefined
        dispatchAfterCommit = committed
        return {
          ok: true,
          value: { dispatched: [], deferred: [{ index: 0, type: 'delivery' }] }
        }
      }
    },
    store: validStore({
      ephemeral: {
        challenges: {
          async create(input) {
            return { ok: true, value: input.record }
          }
        }
      },
      transaction: {
        async run(request, fn) {
          requestedScopes = request.requiredScopes
          const result = await fn({
            transactionId: 'tx_best_effort_outbox',
            covers: [...request.requiredScopes]
          })
          committed = result.ok
          return result
        }
      }
    })
  })

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-account-if-identity-missing' }
  })

  assert.equal(result.ok, true)
  assert.equal(dispatchHadNoTransaction, true)
  assert.equal(dispatchAfterCommit, true)
  assert.deepEqual(requestedScopes, ['challenges'])
})

test('best-effort collaborator exceptions do not fail a persisted begin operation', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  let challengeCreated = false
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'otp.email': challengeMethod({
        calls: [],
        lookup,
        run(input, context) {
          return {
            ok: true,
            value: {
              challengeMaterial: { schemaVersion: 'otp.v1' },
              expiresAt: new Date(context.now.getTime() + 300000),
              maxAttempts: 3,
              sideEffects: [{
                type: 'delivery',
                dispatchPolicy: 'best-effort',
                message: { to: { channel: 'email', target: lookup.subject }, templateId: 'otp' }
              }]
            }
          }
        }
      })
    },
    effects: {
      async dispatch() {
        throw new Error('provider unavailable')
      }
    },
    store: validStore({
      ephemeral: {
        challenges: {
          async create(input) {
            challengeCreated = true
            return { ok: true, value: input.record }
          }
        }
      }
    })
  })

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-account-if-identity-missing' }
  })

  assert.equal(result.ok, true)
  assert.equal(challengeCreated, true)
})

test('missing best-effort dispatcher emits a diagnostic without failing the operation', async () => {
  const events = []
  const now = new Date('2026-01-01T00:00:00.000Z')
  const config = {
    ...minimalConfig({ now }),
    eventSink: {
      async emit(event) {
        events.push(event)
        return { ok: true, value: undefined }
      }
    }
  }

  const result = await dispatchSideEffects(config, { tenantId: 'tenant_1' }, [{
    type: 'delivery',
    dispatchPolicy: 'best-effort',
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp'
    }
  }], now)

  assert.deepEqual(result, { ok: true, value: undefined })
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'auth.side_effect.failed')
  assert.equal(events[0].attributes.reason, 'SIDE_EFFECT_FAILED')
})

test('authenticate runs method-side dummy work for an unknown identity', async () => {
  const lookup = {
    methodId: 'password.email',
    methodKind: 'password',
    subject: 'missing@example.test',
    subjectKind: 'email'
  }
  let methodRuns = 0
  let credentialLookups = 0
  const authResult = createAuth({
    ...minimalConfig(),
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          authenticate: {
            validate() {
              return { ok: true, value: { value: {}, lookup } }
            },
            async run(_input, context) {
              methodRuns += 1
              assert.equal(context.identity, undefined)
              return {
                ok: false,
                error: {
                  type: 'component.failure',
                  component: 'method',
                  reason: 'CREDENTIAL_NOT_FOUND',
                  countsAsAttempt: true,
                  safePublicCodeHint: 'AUTHENTICATION_FAILED'
                }
              }
            }
          }
        }
      }
    },
    store: validStore({
      durable: {
        identities: {
          async findBySubject() {
            return { ok: true, value: null }
          }
        },
        credentials: {
          async findForIdentity() {
            credentialLookups += 1
            throw new Error('credential lookup must not run without an identity')
          }
        }
      }
    })
  })

  assert.equal(authResult.ok, true)
  const result = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {}
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'CREDENTIAL_NOT_FOUND')
  assert.equal(result.error.publicError.code, 'AUTHENTICATION_FAILED')
  assert.equal(methodRuns, 1)
  assert.equal(credentialLookups, 0)
})

test('authenticate rechecks the account inside a declared transaction scope', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'password.email',
    methodKind: 'password',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          authenticate: {
            validate() {
              return { ok: true, value: { value: {}, lookup } }
            },
            async run() {
              return {
                ok: true,
                value: {
                  proof: {
                    type: 'auth.proof',
                    proofMethod: { methodId: lookup.methodId, methodKind: lookup.methodKind },
                    primaryIdentity: lookup,
                    evidence: [],
                    authTime: now
                  }
                }
              }
            }
          }
        }
      }
    },
    store: validStore({
      transaction: undefined,
      durable: {
        identities: {
          async findBySubject() {
            return {
              ok: true,
              value: {
                ...lookup,
                tenantId: 'tenant_1',
                identityId: 'identity_1',
                accountId: 'account_1',
                createdAt: now,
                updatedAt: now
              }
            }
          }
        },
        credentials: {
          async findForIdentity() {
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                credentialId: 'credential_1',
                accountId: 'account_1',
                identityId: 'identity_1',
                methodId: lookup.methodId,
                methodKind: lookup.methodKind,
                status: 'active',
                material: { schemaVersion: 'password.v1' },
                version: 1,
                createdAt: now,
                updatedAt: now
              }
            }
          }
        },
        accounts: {
          async findById() {
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                accountId: 'account_1',
                status: 'active',
                createdAt: now,
                updatedAt: now
              }
            }
          }
        }
      }
    })
  })

  assert.equal(authResult.ok, true)
  const result = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {}
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'TRANSACTION_FAILED')
})

test('authenticate fails safely for missing operations and invalid method validation output', async () => {
  let validationMode = 'failure'
  let denyPolicy = false
  const authResult = createAuth({
    ...minimalConfig(),
    methods: {
      'password.email': successfulEnrollmentMethod(),
      'custom.reject': {
        methodId: 'custom.reject',
        methodKind: 'custom',
        operations: {
          authenticate: {
            validate() {
              if (validationMode === 'failure') {
                return { ok: false, error: { type: 'validation.failure', issues: [] } }
              }
              return validationMode === 'public-data'
                ? {
                    ok: true,
                    value: {
                      value: {},
                      publicData: {
                        secret: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
                      }
                    }
                  }
                : { ok: true, value: { value: {} } }
            },
            async run() {
              throw new Error('invalid method input must not run')
            }
          }
        }
      }
    },
    policy() {
      return denyPolicy ? { allow: false, reason: 'POLICY_DENIED' } : { allow: true }
    }
  })

  const missing = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'missing.method',
    input: {}
  })
  const unsupported = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {}
  })
  const validation = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'custom.reject',
    input: {}
  })
  validationMode = 'public-data'
  const privateData = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'custom.reject',
    input: {}
  })
  validationMode = 'valid'
  denyPolicy = true
  const denied = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'custom.reject',
    input: {}
  })

  assert.equal(missing.error.internalReason, 'METHOD_NOT_CONFIGURED')
  assert.equal(unsupported.error.internalReason, 'METHOD_OPERATION_UNSUPPORTED')
  assert.equal(validation.error.internalReason, 'VALIDATION_FAILED')
  assert.equal(privateData.error.internalReason, 'VALIDATION_FAILED')
  assert.equal(privateData.error.publicError.code, 'INVALID_INPUT')
  assert.equal(denied.error.internalReason, 'POLICY_DENIED')
  assert.equal(denied.error.publicError.code, 'AUTHORIZATION_FAILED')
})

test('authenticate policy rejection happens before credential replacement', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'password.email',
    methodKind: 'password',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  let replaced = false
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          authenticate: {
            validate() {
              return { ok: true, value: { value: {}, lookup } }
            },
            async run() {
              return {
                ok: true,
                value: {
                  proof: {
                    type: 'auth.proof',
                    proofMethod: { methodId: lookup.methodId, methodKind: lookup.methodKind },
                    primaryIdentity: lookup,
                    evidence: [],
                    authTime: now
                  },
                  credentialMaterial: { schemaVersion: 'password.v1' }
                }
              }
            }
          }
        }
      }
    },
    policy(check) {
      return check.kind === 'accept-proof'
        ? { allow: false, reason: 'POLICY_DENIED' }
        : { allow: true }
    },
    store: validStore({
      durable: {
        identities: {
          async findBySubject() {
            return {
              ok: true,
              value: {
                ...lookup,
                tenantId: 'tenant_1',
                identityId: 'identity_1',
                accountId: 'account_1',
                createdAt: now,
                updatedAt: now
              }
            }
          }
        },
        credentials: {
          async findForIdentity() {
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                credentialId: 'credential_1',
                accountId: 'account_1',
                identityId: 'identity_1',
                methodId: 'password.email',
                methodKind: 'password',
                status: 'active',
                version: 1,
                material: { schemaVersion: 'password.v1' },
                createdAt: now,
                updatedAt: now
              }
            }
          },
          async replaceMaterial() {
            replaced = true
            return { ok: true, value: {} }
          }
        },
        accounts: {
          async findById() {
            throw new Error('account lookup should not run')
          }
        }
      },
      session: { sessions: {} }
    })
  })

  const result = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {}
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'POLICY_DENIED')
  assert.equal(replaced, false)
})

test('authenticate rechecks proof expiry before transactional persistence', async () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date(startedAt.getTime() + 1000)
  let clockNow = startedAt
  let accountRead = false
  const lookup = {
    methodId: 'password.email',
    methodKind: 'password',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const identity = {
    ...lookup,
    tenantId: 'tenant_1',
    identityId: 'identity_1',
    accountId: 'account_1',
    createdAt: startedAt,
    updatedAt: startedAt
  }
  const credential = {
    tenantId: 'tenant_1',
    credentialId: 'credential_1',
    accountId: 'account_1',
    identityId: 'identity_1',
    methodId: 'password.email',
    methodKind: 'password',
    status: 'active',
    version: 1,
    material: { schemaVersion: 'password.v1' },
    createdAt: startedAt,
    updatedAt: startedAt
  }
  const authResult = createAuth({
    ...minimalConfig({ now: startedAt }),
    clock: {
      now() {
        return clockNow
      }
    },
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          authenticate: {
            validate() {
              return { ok: true, value: { value: {}, lookup } }
            },
            async run() {
              clockNow = new Date(expiresAt.getTime() + 1)
              return {
                ok: true,
                value: {
                  proof: {
                    type: 'auth.proof',
                    proofMethod: { methodId: 'password.email', methodKind: 'password' },
                    primaryIdentity: lookup,
                    evidence: [],
                    authTime: startedAt,
                    expiresAt
                  }
                }
              }
            }
          }
        }
      }
    },
    store: validStore({
      durable: {
        identities: {
          async findBySubject() {
            return { ok: true, value: identity }
          }
        },
        credentials: {
          async findForIdentity() {
            return { ok: true, value: credential }
          }
        },
        accounts: {
          async findById() {
            accountRead = true
            return { ok: true, value: accountRecord(startedAt) }
          }
        }
      }
    })
  })

  const result = await authResult.value.authenticate({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {}
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'AUTHENTICATION_FAILED')
  assert.equal(accountRead, false)
})

test('complete refuses to link a challenge under a different actor', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let validated = false
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'otp.email': {
        methodId: 'otp.email',
        methodKind: 'otp',
        operations: {
          complete: {
            validate() {
              validated = true
              return { ok: false, error: {} }
            },
            async run() {
              throw new Error('run should not be called')
            }
          }
        }
      }
    },
    store: validStore({
      durable: { accounts: {}, identities: {}, credentials: {} },
      session: { sessions: {} },
      ephemeral: {
        challenges: {
          async findById() {
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                challengeId: 'challenge_1',
                methodId: 'otp.email',
                methodKind: 'otp',
                status: 'pending',
                material: { schemaVersion: 'otp.v1' },
                binding: {
                  account: { mode: 'link-to-actor-account' },
                  startedByActor: { type: 'account', accountId: 'account_a' }
                },
                attempts: 0,
                maxAttempts: 3,
                version: 1,
                expiresAt: new Date(now.getTime() + 300000),
                createdAt: now,
                updatedAt: now
              }
            }
          }
        }
      }
    })
  })

  const result = await authResult.value.complete({
    context: { tenantId: 'tenant_1', actor: { type: 'account', accountId: 'account_b' } },
    challengeId: 'challenge_1',
    input: {}
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'ACCOUNT_LINKING_DENIED')
  assert.equal(validated, false)
})

test('complete rejects a stored challenge from a different method kind', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let validated = false
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'otp.email': {
        methodId: 'otp.email',
        methodKind: 'otp',
        operations: {
          complete: {
            validate() {
              validated = true
              return { ok: false, error: {} }
            },
            async run() {
              throw new Error('run should not be called')
            }
          }
        }
      }
    },
    store: validStore({
      ephemeral: {
        challenges: {
          async findById() {
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                challengeId: 'challenge_1',
                methodId: 'otp.email',
                methodKind: 'legacy-otp',
                status: 'pending',
                material: { schemaVersion: 'otp.v1' },
                binding: { account: { mode: 'require-existing-identity' } },
                attempts: 0,
                maxAttempts: 3,
                version: 1,
                expiresAt: new Date(now.getTime() + 300000),
                createdAt: now,
                updatedAt: now
              }
            }
          }
        }
      }
    })
  })

  const result = await authResult.value.complete({
    context: { tenantId: 'tenant_1' },
    challengeId: 'challenge_1',
    input: {}
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'METHOD_NOT_CONFIGURED')
  assert.equal(validated, false)
})

test('complete rechecks challenge expiry after method execution', async () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date(startedAt.getTime() + 1000)
  let clockNow = startedAt
  let consumed = false
  const outcomes = []
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const authResult = createAuth({
    ...minimalConfig({ now: startedAt }),
    clock: {
      now() {
        return clockNow
      }
    },
    guard: {
      async beforeAttempt() {
        return { ok: true, value: { allow: true } }
      },
      async afterAttempt(input) {
        outcomes.push(input.outcome)
        return { ok: true, value: undefined }
      }
    },
    methods: {
      'otp.email': {
        methodId: 'otp.email',
        methodKind: 'otp',
        operations: {
          complete: {
            validate() {
              return { ok: true, value: { value: {}, lookup } }
            },
            async run() {
              clockNow = new Date(expiresAt.getTime() + 1)
              return {
                ok: true,
                value: {
                  proof: {
                    type: 'auth.proof',
                    proofMethod: { methodId: 'otp.email', methodKind: 'otp' },
                    primaryIdentity: lookup,
                    evidence: [],
                    authTime: startedAt
                  }
                }
              }
            }
          }
        }
      }
    },
    store: validStore({
      ephemeral: {
        challenges: {
          async findById() {
            return {
              ok: true,
              value: {
                tenantId: 'tenant_1',
                challengeId: 'challenge_1',
                methodId: 'otp.email',
                methodKind: 'otp',
                lookup,
                status: 'pending',
                material: { schemaVersion: 'otp.v1' },
                binding: { account: { mode: 'require-existing-identity' } },
                attempts: 0,
                maxAttempts: 3,
                version: 1,
                expiresAt,
                createdAt: startedAt,
                updatedAt: startedAt
              }
            }
          },
          async consumePending() {
            consumed = true
            return { ok: true, value: 'consumed' }
          }
        }
      }
    })
  })

  const result = await authResult.value.complete({
    context: { tenantId: 'tenant_1' },
    challengeId: 'challenge_1',
    input: {}
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'CHALLENGE_EXPIRED')
  assert.equal(result.error.publicError.code, 'CHALLENGE_FAILED')
  assert.equal(consumed, false)
  assert.deepEqual(outcomes, [{
    success: false,
    reason: 'CHALLENGE_EXPIRED',
    countsAsAttempt: false
  }])
})

test('begin refuses to persist a challenge that expires during method execution', async () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z')
  const expiresAt = new Date(startedAt.getTime() + 1000)
  let clockNow = startedAt
  let created = false
  const authResult = createAuth({
    ...minimalConfig({ now: startedAt }),
    clock: {
      now() {
        return clockNow
      }
    },
    methods: {
      'otp.email': {
        methodId: 'otp.email',
        methodKind: 'otp',
        operations: {
          begin: {
            validate() {
              return { ok: true, value: { value: {} } }
            },
            async run() {
              clockNow = new Date(expiresAt.getTime() + 1)
              return {
                ok: true,
                value: {
                  challengeMaterial: { schemaVersion: 'otp.v1' },
                  expiresAt,
                  maxAttempts: 3
                }
              }
            }
          }
        }
      }
    },
    store: validStore({
      ephemeral: {
        challenges: {
          async create(input) {
            created = true
            return { ok: true, value: input.record }
          }
        }
      }
    })
  })

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'CHALLENGE_EXPIRED')
  assert.equal(created, false)
})

test('successful persistence events are emitted only after the transaction commits', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'otp.email',
    methodKind: 'otp',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  const observations = []
  let transactionActive = false
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'otp.email': challengeMethod({
        calls: [],
        lookup,
        run(input, context) {
          return {
            ok: true,
            value: {
              challengeMaterial: { schemaVersion: 'otp.v1' },
              expiresAt: new Date(context.now.getTime() + 300000),
              maxAttempts: 3,
              sideEffects: [{
                type: 'delivery',
                dispatchPolicy: 'required',
                idempotencyKey: 'begin-events-after-commit',
                message: { to: { channel: 'email', target: lookup.subject }, templateId: 'otp' }
              }]
            }
          }
        }
      })
    },
    effects: {
      transactionScopes: ['outbox'],
      async dispatch() {
        return { ok: true, value: { dispatched: [{ index: 0, type: 'delivery' }] } }
      }
    },
    eventSink: {
      async emit(event) {
        observations.push({ name: event.name, transactionActive })
        return { ok: true, value: undefined }
      }
    },
    store: validStore({
      durable: {
        identities: {
          async findBySubject() {
            return { ok: true, value: null }
          }
        }
      },
      ephemeral: { challenges: {} },
      transaction: {
        async run(_request, fn) {
          transactionActive = true
          const result = await fn({ transactionId: 'tx_1', covers: ['challenges', 'outbox'] })
          transactionActive = false
          return result
        }
      }
    })
  })

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-account-if-identity-missing' }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(observations, [
    { name: 'auth.side_effect.dispatched', transactionActive: false },
    { name: 'auth.challenge.started', transactionActive: false }
  ])
})

test('session creation fails if asynchronous issuance outlives the session TTL', async () => {
  const startedAt = new Date('2026-01-01T00:00:00.000Z')
  let clockNow = startedAt
  const proof = {
    type: 'auth.proof',
    proofMethod: { methodId: 'password.email', methodKind: 'password' },
    primaryIdentity: {
      methodId: 'password.email',
      methodKind: 'password',
      subject: 'user@example.test',
      subjectKind: 'email'
    },
    evidence: [],
    authTime: startedAt
  }
  const config = {
    ...minimalConfig({ now: startedAt }),
    clock: {
      now() {
        return clockNow
      }
    },
    session: {
      defaultTtlSeconds: 1
    },
    token: {
      async identify() {
        return { ok: true, value: null }
      },
      async issue() {
        clockNow = new Date(startedAt.getTime() + 1001)
        return {
          ok: true,
          value: {
            raw: rawSecret('token'),
            tokenHash: protectedValue('hash:token')
          }
        }
      }
    }
  }

  const result = await createSession(
    config,
    { tenantId: 'tenant_1' },
    'account_1',
    proof,
    {},
    startedAt
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'SESSION_EXPIRED')
  assert.equal(result.error.publicError.code, 'SESSION_INVALID')
})

test('session creation rejects fractional TTL before issuing a token', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const lookup = {
    methodId: 'password.email',
    methodKind: 'password',
    subject: 'user@example.test',
    subjectKind: 'email'
  }
  let tokenIssued = false
  const authResult = createAuth({
    ...minimalConfig({ now }),
    token: {
      async identify() {
        return { ok: true, value: null }
      },
      async issue() {
        tokenIssued = true
        return { ok: true, value: { raw: rawSecret('token'), tokenHash: protectedValue('hash') } }
      }
    },
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          enroll: {
            validate() {
              return { ok: true, value: { value: {}, lookup } }
            },
            async run() {
              return {
                ok: true,
                value: {
                  identity: lookup,
                  proof: {
                    type: 'auth.proof',
                    proofMethod: { methodId: lookup.methodId, methodKind: lookup.methodKind },
                    primaryIdentity: lookup,
                    evidence: [],
                    authTime: now
                  }
                }
              }
            }
          }
        }
      }
    }
  })

  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' },
    session: { ttlSeconds: 1.5 }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'SESSION_TTL_INVALID')
  assert.equal(result.error.publicError.code, 'INVALID_INPUT')
  assert.equal(tokenIssued, false)
})

test('session creation rejects TTL values that overflow the Date range', async () => {
  let issued = false
  const config = {
    ...minimalConfig(),
    token: {
      ...minimalConfig().token,
      async issue() {
        issued = true
        throw new Error('token should not be issued')
      }
    }
  }
  const proof = {
    type: 'auth.proof',
    proofMethod: { methodId: 'password.email', methodKind: 'password' },
    primaryIdentity: {
      methodId: 'password.email',
      methodKind: 'password',
      subject: 'user@example.test',
      subjectKind: 'email'
    },
    evidence: [],
    authTime: new Date('2026-01-01T00:00:00.000Z')
  }

  const result = await createSession(
    config,
    { tenantId: 'tenant_1' },
    'account_1',
    proof,
    { ttlSeconds: Number.MAX_SAFE_INTEGER },
    new Date('2026-01-01T00:00:00.000Z')
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'SESSION_TTL_INVALID')
  assert.equal(issued, false)
})

test('operations reject invalid clocks before invoking configured methods', async (t) => {
  for (const [name, now] of [
    ['invalid date', () => new Date(Number.NaN)],
    ['throwing clock', () => { throw new Error('private clock failure') }]
  ]) {
    await t.test(name, async () => {
      let validated = false
      const authResult = createAuth({
        ...minimalConfig(),
        clock: { now },
        methods: {
          'password.email': {
            ...successfulEnrollmentMethod(),
            operations: {
              enroll: {
                validate() {
                  validated = true
                  throw new Error('validator should not run')
                },
                async run() {
                  throw new Error('method should not run')
                }
              }
            }
          }
        }
      })

      const result = await authResult.value.enroll({
        context: { tenantId: 'tenant_1' },
        methodId: 'password.email',
        input: {},
        account: { mode: 'create-new-account' }
      })

      assert.equal(result.ok, false)
      assert.equal(result.error.internalReason, 'INTERNAL')
      assert.equal(validated, false)
    })
  }
})

test('operation state is isolated from caller and collaborator mutations', async () => {
  const callerContext = {
    tenantId: 'tenant_1',
    policyInput: { risk: 'low' },
    metadata: { requestSource: 'test' }
  }
  let releaseGuard
  const guardWait = new Promise((resolve) => {
    releaseGuard = resolve
  })
  const observedTenants = []
  const now = new Date('2026-01-01T00:00:00.000Z')
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          enroll: {
            validate(_input, context) {
              assert.equal('metadata' in context.auth, false)
              assert.deepEqual(context.auth.policyInput, { risk: 'low' })
              context.auth.tenantId = 'mutated_by_validator'
              context.now.setTime(0)
              return { ok: true, value: { value: {} } }
            },
            async run(_input, context) {
              assert.equal('metadata' in context.auth, false)
              assert.deepEqual(context.auth.policyInput, { risk: 'low' })
              context.auth.tenantId = 'mutated_by_method'
              context.now.setTime(0)
              return {
                ok: true,
                value: {
                  identity: {
                    methodId: 'password.email',
                    methodKind: 'password',
                    subject: 'user@example.test',
                    subjectKind: 'email'
                  }
                }
              }
            }
          }
        }
      }
    },
    guard: {
      async beforeAttempt(input) {
        assert.equal('metadata' in input.context, false)
        assert.deepEqual(input.context.policyInput, { risk: 'low' })
        input.context.tenantId = 'mutated_by_guard'
        await guardWait
        return { ok: true, value: { allow: true } }
      },
      async afterAttempt(input) {
        assert.equal('metadata' in input.context, false)
        assert.deepEqual(input.context.policyInput, { risk: 'low' })
        input.context.tenantId = 'mutated_after_attempt'
        return { ok: true, value: undefined }
      }
    },
    policy(check) {
      assert.equal('metadata' in check.context, false)
      assert.deepEqual(check.context.policyInput, { risk: 'low' })
      check.context.tenantId = 'mutated_by_policy'
      return { allow: true }
    },
    idGenerator: {
      generate(input) {
        observedTenants.push(input.tenantId)
        return `${input.kind}_1`
      }
    },
    store: validStore({
      durable: {
        accounts: {
          async create(input) {
            observedTenants.push(input.record.tenantId)
            assert.equal(input.record.createdAt.getTime(), now.getTime())
            return { ok: true, value: input.record }
          }
        },
        identities: {
          async create(input) {
            observedTenants.push(input.record.tenantId)
            assert.equal(input.record.createdAt.getTime(), now.getTime())
            return { ok: true, value: input.record }
          }
        }
      }
    })
  })

  const pending = authResult.value.enroll({
    context: callerContext,
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })
  callerContext.tenantId = 'mutated_by_caller'
  callerContext.metadata.requestSource = 'mutated'
  releaseGuard()
  const result = await pending

  assert.equal(result.ok, true)
  assert.deepEqual(observedTenants, [
    'tenant_1',
    'tenant_1',
    'tenant_1',
    'tenant_1'
  ])
})

test('validated method output is snapshotted before asynchronous policy and persistence', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  class StatefulDate extends Date {
    reads = 0

    override getTime(): number {
      this.reads += 1
      return this.reads === 1
        ? Date.prototype.getTime.call(this)
        : Number.NaN
    }
  }
  const verifiedAt = new StatefulDate(now)
  const authTime = new StatefulDate(now)
  const effectExpiresAt = new StatefulDate(now.getTime() + 60000)
  let releasePolicy
  let policyReached
  const waitingPolicy = new Promise((resolve) => {
    releasePolicy = resolve
  })
  const reachedPolicy = new Promise((resolve) => {
    policyReached = resolve
  })
  const rawCode = rawSecret('123456')
  const passwordHash = protectedValue('hash:original')
  const sealedPayload = sealedValue('ciphertext:original')
  rawCode.redacted = '123456'
  rawCode.toJSON = () => '123456'
  passwordHash.redacted = 'hash:original'
  passwordHash.toJSON = () => 'hash:original'
  sealedPayload.redacted = 'ciphertext:original'
  sealedPayload.toJSON = () => 'ciphertext:original'
  const output = {
    identity: {
      methodId: 'password.email',
      methodKind: 'password',
      subject: 'user@example.test',
      subjectKind: 'email',
      verifiedAt
    },
    credentialMaterial: {
      schemaVersion: 'password.v1',
      publicData: { algorithm: 'pbkdf2' },
      privateData: {
        passwordHash,
        sealedPayload,
        iterations: 600000
      }
    },
    proof: {
      type: 'auth.proof',
      proofMethod: { methodId: 'password.email', methodKind: 'password' },
      primaryIdentity: {
        methodId: 'password.email',
        methodKind: 'password',
        subject: 'user@example.test',
        subjectKind: 'email'
      },
      evidence: [],
      authTime,
      claims: { source: 'password' }
    },
    sideEffects: [{
      type: 'delivery',
      dispatchPolicy: 'required',
      idempotencyKey: 'delivery_1',
      expiresAt: effectExpiresAt,
      message: {
        to: { channel: 'email', target: 'user@example.test' },
        templateId: 'welcome.v1',
        data: { code: rawCode, purpose: { kind: 'welcome' } },
        metadata: { campaign: 'first-release' }
      }
    }],
    publicData: { flow: 'enrollment' }
  }
  const authResult = createAuth({
    ...minimalConfig({ now }),
    methods: {
      'password.email': {
        methodId: 'password.email',
        methodKind: 'password',
        operations: {
          enroll: {
            validate() {
              return { ok: true, value: { value: {} } }
            },
            async run() {
              return { ok: true, value: output }
            }
          }
        }
      }
    },
    policy: async (check) => {
      if (check.kind === 'accept-enrollment') {
        policyReached()
        await waitingPolicy
      }
      return { allow: true }
    },
    effects: {
      transactionScopes: ['outbox'],
      async dispatch(input) {
        assert.equal(input.effects[0].dispatchPolicy, 'required')
        assert.equal(input.effects[0].message.to.target, 'user@example.test')
        assert.equal(input.effects[0].message.data.code.redacted, '[REDACTED]')
        assert.equal(input.effects[0].message.data.code.toJSON(), '[REDACTED]')
        assert.equal(input.effects[0].message.data.code.reveal(), '123456')
        assert.equal(JSON.stringify(input.effects).includes('123456'), false)
        assert.deepEqual(input.effects[0].message.data.purpose, { kind: 'welcome' })
        assert.deepEqual(input.effects[0].message.metadata, { campaign: 'first-release' })
        assert.equal(input.effects[0].expiresAt.getTime(), now.getTime() + 60000)
        return { ok: true, value: { dispatched: [{ index: 0, type: 'delivery' }] } }
      }
    },
    store: validStore({
      durable: {
        identities: {
          async create(input) {
            assert.equal(input.record.subject, 'user@example.test')
            assert.equal(input.record.verifiedAt.getTime(), now.getTime())
            return { ok: true, value: input.record }
          }
        },
        credentials: {
          async create(input) {
            assert.equal(input.record.material.schemaVersion, 'password.v1')
            assert.deepEqual(input.record.material.publicData, { algorithm: 'pbkdf2' })
            assert.equal(input.record.material.privateData.passwordHash.scheme, 'test.v1')
            assert.equal(input.record.material.privateData.passwordHash.redacted, '[REDACTED]')
            assert.equal(input.record.material.privateData.passwordHash.toJSON(), '[REDACTED]')
            assert.equal(input.record.material.privateData.passwordHash.revealForPersistence(), 'hash:original')
            assert.equal(input.record.material.privateData.sealedPayload.algorithm, 'test.v1')
            assert.equal(input.record.material.privateData.sealedPayload.redacted, '[REDACTED]')
            assert.equal(input.record.material.privateData.sealedPayload.toJSON(), '[REDACTED]')
            assert.equal(
              input.record.material.privateData.sealedPayload.revealCiphertextForPersistence(),
              'ciphertext:original'
            )
            return { ok: true, value: input.record }
          }
        }
      }
    })
  })

  const pending = authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })
  await reachedPolicy
  output.identity.subject = 'mutated@example.test'
  output.identity.verifiedAt.setTime(0)
  output.credentialMaterial.schemaVersion = 'mutated.v1'
  output.credentialMaterial.publicData.algorithm = 'mutated'
  passwordHash.scheme = 'mutated.v1'
  sealedPayload.algorithm = 'mutated.v1'
  output.proof.primaryIdentity.subject = 'mutated@example.test'
  output.proof.authTime.setTime(0)
  output.sideEffects[0].dispatchPolicy = 'best-effort'
  output.sideEffects[0].message.to.target = 'attacker@example.test'
  output.sideEffects[0].message.data.purpose.kind = 'mutated'
  output.sideEffects[0].message.metadata.campaign = 'mutated'
  output.sideEffects[0].expiresAt.setTime(0)
  output.publicData.flow = 'mutated'
  releasePolicy()
  const result = await pending

  assert.equal(result.ok, true)
  assert.equal(result.value.identity.subject, 'user@example.test')
  assert.equal(result.value.proof.primaryIdentity.subject, 'user@example.test')
  assert.equal(result.value.proof.authTime.getTime(), now.getTime())
  assert.deepEqual(result.value.publicData, { flow: 'enrollment' })
  assert.equal(verifiedAt.reads, 0)
  assert.equal(authTime.reads, 0)
  assert.equal(effectExpiresAt.reads, 0)
})

test('enroll emits started and succeeded lifecycle events', async () => {
  const events = []
  const authResult = createAuth({
    ...minimalConfig(),
    methods: { 'password.email': successfulEnrollmentMethod() },
    eventSink: {
      async emit(event) {
        events.push(event.name)
        return { ok: true, value: undefined }
      }
    }
  })

  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(events, ['auth.enroll.started', 'auth.enroll.succeeded'])
})

test('enrollment fails before persistence when no transaction is available', async () => {
  let accountCreates = 0
  const authResult = createAuth({
    ...minimalConfig(),
    methods: { 'password.email': successfulEnrollmentMethod() },
    store: validStore({
      transaction: undefined,
      durable: {
        accounts: {
          async create(input) {
            accountCreates += 1
            return { ok: true, value: input.record }
          }
        }
      }
    })
  })

  assert.equal(authResult.ok, true)
  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'TRANSACTION_FAILED')
  assert.equal(accountCreates, 0)
})

test('enrollment rejects thrown, malformed, or incomplete transaction runners', async (t) => {
  const fabricatedAt = new Date('2026-01-01T00:00:00.000Z')
  const runners = [
    {
      name: 'thrown runner',
      transaction: { async run() { throw new Error('transaction failed') } }
    },
    {
      name: 'malformed result',
      transaction: { async run() { return { ok: true } } }
    },
    {
      name: 'malformed auth failure',
      transaction: {
        async run() {
          return {
            ok: false,
            error: {
              type: 'auth.failure',
              internalReason: 'TRANSACTION_FAILED',
              publicError: { code: 'PRIVATE_PROVIDER_CODE' }
            }
          }
        }
      }
    },
    {
      name: 'fabricated success without callback',
      transaction: {
        async run() {
          return {
            ok: true,
            value: {
              account: accountRecord(fabricatedAt),
              identity: {
                tenantId: 'tenant_1',
                identityId: 'identity_fabricated',
                accountId: 'account_1',
                methodId: 'password.email',
                methodKind: 'password',
                subject: 'user@example.test',
                subjectKind: 'email',
                createdAt: fabricatedAt,
                updatedAt: fabricatedAt
              },
              effects: []
            }
          }
        }
      }
    },
    {
      name: 'substituted success after callback',
      expectedAccountCreates: 1,
      transaction: {
        async run(_request, fn) {
          const callbackResult = await fn({
            transactionId: 'tx_substituted',
            covers: ['accounts', 'identities', 'credentials', 'sessions', 'challenges']
          })
          return {
            ok: true,
            value: {
              marker: callbackResult.value?.marker,
              value: 'substituted'
            }
          }
        }
      }
    },
    {
      name: 'callback invoked more than once',
      expectedAccountCreates: 1,
      transaction: {
        async run(_request, fn) {
          const tx = {
            transactionId: 'tx_repeated',
            covers: ['accounts', 'identities', 'credentials', 'sessions', 'challenges']
          }
          const first = await fn(tx)
          try {
            await fn(tx)
          } catch {
            return first
          }
          return first
        }
      }
    },
    {
      name: 'incomplete scope coverage',
      transaction: {
        async run(_request, fn) {
          return fn({ transactionId: 'tx_incomplete', covers: ['accounts'] })
        }
      }
    }
  ]

  for (const { name, transaction, expectedAccountCreates = 0 } of runners) {
    await t.test(name, async () => {
      let accountCreates = 0
      const authResult = createAuth({
        ...minimalConfig(),
        methods: { 'password.email': successfulEnrollmentMethod() },
        store: validStore({
          transaction,
          durable: {
            accounts: {
              async create(input) {
                accountCreates += 1
                return { ok: true, value: input.record }
              }
            }
          }
        })
      })

      assert.equal(authResult.ok, true)
      const result = await authResult.value.enroll({
        context: { tenantId: 'tenant_1' },
        methodId: 'password.email',
        input: {},
        account: { mode: 'create-new-account' }
      })

      assert.equal(result.ok, false)
      assert.equal(result.error.internalReason, 'TRANSACTION_FAILED')
      assert.equal(accountCreates, expectedAccountCreates)
    })
  }
})

test('transaction runners may return a structural copy of the callback result', async () => {
  const authResult = createAuth({
    ...minimalConfig(),
    methods: { 'password.email': successfulEnrollmentMethod() },
    store: validStore({
      transaction: {
        async run(_request, fn) {
          const result = await fn({
            transactionId: 'tx_structural_copy',
            covers: ['accounts', 'identities', 'credentials', 'sessions', 'challenges']
          })
          return structuredClone(result)
        }
      }
    })
  })

  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, true)
})

test('transaction commit failure records exactly one failed attempt', async () => {
  const outcomes = []
  const authResult = createAuth({
    ...minimalConfig(),
    methods: { 'password.email': successfulEnrollmentMethod() },
    guard: {
      async beforeAttempt() {
        return { ok: true, value: { allow: true } }
      },
      async afterAttempt(input) {
        outcomes.push(input.outcome)
        return { ok: true, value: undefined }
      }
    },
    store: validStore({
      transaction: {
        async run(_request, fn) {
          const callbackResult = await fn({
            transactionId: 'tx_1',
            covers: ['accounts', 'identities', 'credentials', 'sessions', 'challenges']
          })
          assert.equal(callbackResult.ok, true)
          return {
            ok: false,
            error: {
              type: 'component.failure',
              component: 'transaction',
              reason: 'TRANSACTION_FAILED'
            }
          }
        }
      }
    })
  })

  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'TRANSACTION_FAILED')
  assert.deepEqual(outcomes, [{
    success: false,
    reason: 'TRANSACTION_FAILED',
    countsAsAttempt: false
  }])
})

test('enroll rejects an invalid generated credential identifier', async () => {
  const authResult = createAuth({
    ...minimalConfig(),
    methods: {
      'password.email': successfulEnrollmentMethod({
        credentialMaterial: { schemaVersion: 'password.v1' }
      })
    },
    idGenerator: {
      generate(input) {
        return input.kind === 'credential' ? '' : `${input.kind}_1`
      }
    }
  })

  const result = await authResult.value.enroll({
    context: { tenantId: 'tenant_1' },
    methodId: 'password.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'INTERNAL')
})

test('begin rejects an invalid generated challenge identifier before method execution', async () => {
  const calls = []
  const config = beginConfig({
    calls,
    method: challengeMethod({
      calls,
      lookup: undefined,
      run() {
        calls.push('run')
        throw new Error('method should not run')
      }
    })
  })
  config.idGenerator.generate = () => '\u0000invalid'
  const authResult = createAuth(config)

  const result = await authResult.value.begin({
    context: { tenantId: 'tenant_1' },
    methodId: 'otp.email',
    input: {},
    account: { mode: 'create-new-account' }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'INTERNAL')
  assert.deepEqual(calls, ['validate'])
})

test('session creation rejects an invalid generated identifier before token issuance', async () => {
  let issued = false
  const config = {
    ...minimalConfig(),
    idGenerator: { generate: () => 'x'.repeat(513) },
    token: {
      ...minimalConfig().token,
      async issue() {
        issued = true
        throw new Error('token should not be issued')
      }
    }
  }
  const proof = {
    type: 'auth.proof',
    proofMethod: { methodId: 'password.email', methodKind: 'password' },
    primaryIdentity: {
      methodId: 'password.email',
      methodKind: 'password',
      subject: 'user@example.test',
      subjectKind: 'email'
    },
    evidence: [],
    authTime: new Date('2026-01-01T00:00:00.000Z')
  }

  const result = await createSession(
    config,
    { tenantId: 'tenant_1' },
    'account_1',
    proof,
    {},
    new Date('2026-01-01T00:00:00.000Z')
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'INTERNAL')
  assert.equal(issued, false)
})

test('session creation rejects malformed and failed token issue results before persistence', async (t) => {
  const proof = {
    type: 'auth.proof',
    proofMethod: { methodId: 'password.email', methodKind: 'password' },
    primaryIdentity: {
      methodId: 'password.email',
      methodKind: 'password',
      subject: 'user@example.test',
      subjectKind: 'email'
    },
    evidence: [],
    authTime: new Date('2026-01-01T00:00:00.000Z')
  }
  const cases = [
    {
      name: 'malformed success',
      expectedReason: 'INTERNAL',
      async issue() {
        return { ok: true, value: { raw: 'plain-text', tokenHash: protectedValue('hash') } }
      }
    },
    {
      name: 'component failure',
      expectedReason: 'CRYPTO_FAILED',
      async issue() {
        return {
          ok: false,
          error: {
            type: 'component.failure',
            component: 'token',
            reason: 'CRYPTO_FAILED'
          }
        }
      }
    }
  ]

  for (const current of cases) {
    await t.test(current.name, async () => {
      let persisted = false
      const config = {
        ...minimalConfig(),
        token: {
          ...minimalConfig().token,
          issue: current.issue
        },
        store: validStore({
          session: {
            sessions: {
              async create() {
                persisted = true
                throw new Error('session should not persist')
              }
            }
          }
        })
      }
      const result = await createSession(
        config,
        { tenantId: 'tenant_1' },
        'account_1',
        proof,
        {},
        new Date('2026-01-01T00:00:00.000Z')
      )

      assert.equal(result.ok, false)
      assert.equal(result.error.internalReason, current.expectedReason)
      assert.equal(result.error.publicError.code, 'TEMPORARILY_UNAVAILABLE')
      assert.equal(persisted, false)
    })
  }
})

test('session creation snapshots an untrusted raw token wrapper before returning it', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const secretValue = 'raw-token-must-not-serialize'
  const proof = {
    type: 'auth.proof',
    proofMethod: { methodId: 'password.email', methodKind: 'password' },
    primaryIdentity: {
      methodId: 'password.email',
      methodKind: 'password',
      subject: 'user@example.test',
      subjectKind: 'email'
    },
    evidence: [],
    authTime: now
  }
  const config = {
    ...minimalConfig({ now }),
    token: {
      ...minimalConfig({ now }).token,
      async issue() {
        return {
          ok: true,
          value: {
            raw: {
              type: 'raw-secret',
              redacted: secretValue,
              reveal() {
                return secretValue
              },
              toJSON() {
                return secretValue
              }
            },
            tokenHash: protectedValue('hash')
          }
        }
      }
    },
    store: validStore({
      session: {
        sessions: {
          async create(input) {
            return { ok: true, value: input.record }
          }
        }
      }
    })
  }

  const result = await createSession(
    config,
    { tenantId: 'tenant_1' },
    'account_1',
    proof,
    {},
    now
  )
  assert.equal(result.ok, true)
  assert.equal(result.value.token.raw.reveal(), secretValue)
  assert.equal(JSON.stringify(result).includes(secretValue), false)
})

test('session creation rejects a malformed store acknowledgement', async () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const proof = {
    type: 'auth.proof',
    proofMethod: { methodId: 'password.email', methodKind: 'password' },
    primaryIdentity: {
      methodId: 'password.email',
      methodKind: 'password',
      subject: 'user@example.test',
      subjectKind: 'email'
    },
    evidence: [],
    authTime: now
  }
  const config = {
    ...minimalConfig({ now }),
    store: validStore({
      session: {
        sessions: {
          async create(input) {
            input.record.status = 'revoked'
            input.record.revokedAt = now
            return { ok: true, value: input.record }
          }
        }
      }
    })
  }

  const result = await createSession(
    config,
    { tenantId: 'tenant_1' },
    'account_1',
    proof,
    {},
    now
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.internalReason, 'INTERNAL')
  assert.equal(result.error.publicError.code, 'TEMPORARILY_UNAVAILABLE')
})

function successfulEnrollmentMethod(output = {}) {
  return {
    methodId: 'password.email',
    methodKind: 'password',
    operations: {
      enroll: {
        validate() {
          return { ok: true, value: { value: {} } }
        },
        async run() {
          return {
            ok: true,
            value: {
              identity: {
                methodId: 'password.email',
                methodKind: 'password',
                subject: 'user@example.test',
                subjectKind: 'email'
              },
              ...output
            }
          }
        }
      }
    }
  }
}

function minimalConfig(options = {}) {
  const now = options.now ?? new Date('2026-01-01T00:00:00.000Z')
  return {
    methods: {},
    clock: {
      now() {
        return now
      }
    },
    idGenerator: {
      generate(input) {
        return `${input.kind}_1`
      }
    },
    session: {
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 7200
    },
    token: {
      async identify() {
        return { ok: true, value: null }
      },
      async issue() {
        return {
          ok: true,
          value: {
            raw: rawSecret('token'),
            tokenHash: protectedValue('hash:token')
          }
        }
      }
    },
    store: validStore()
  }
}

function validStore(overrides = {}) {
  const passthroughCreate = async (input) => ({ ok: true, value: input.record })
  const nullable = async () => ({ ok: true, value: null })
  const unavailableUpdate = async () => ({
    ok: false,
    error: { type: 'component.failure', component: 'store', reason: 'STORE_UNAVAILABLE' }
  })
  const base = {
    durable: {
      accounts: {
        create: passthroughCreate,
        findById: nullable,
        updateStatus: unavailableUpdate
      },
      identities: {
        create: passthroughCreate,
        findById: nullable,
        findBySubject: nullable,
        markVerified: unavailableUpdate
      },
      credentials: {
        create: passthroughCreate,
        findById: nullable,
        findForIdentity: nullable,
        replaceMaterial: unavailableUpdate,
        updateStatus: unavailableUpdate
      }
    },
    session: {
      sessions: {
        create: passthroughCreate,
        findById: nullable,
        findByTokenHash: nullable,
        revoke: nullable,
        async cleanupExpired() {
          return { ok: true, value: 0 }
        }
      }
    },
    transaction: {
      async run(request, fn) {
        return fn({
          transactionId: 'tx_test',
          covers: [...request.requiredScopes]
        })
      }
    }
  }
  const challenges = overrides.ephemeral?.challenges
    ? {
        create: passthroughCreate,
        findById: nullable,
        async recordFailedAttempt() {
          return { ok: true, value: { status: 'version-conflict' } }
        },
        async consumePending() {
          return { ok: true, value: 'version-conflict' }
        },
        async cleanupExpired() {
          return { ok: true, value: 0 }
        },
        ...overrides.ephemeral.challenges
      }
    : undefined

  return {
    ...base,
    ...overrides,
    durable: {
      ...base.durable,
      ...overrides.durable,
      accounts: { ...base.durable.accounts, ...overrides.durable?.accounts },
      identities: { ...base.durable.identities, ...overrides.durable?.identities },
      credentials: { ...base.durable.credentials, ...overrides.durable?.credentials }
    },
    session: {
      ...base.session,
      ...overrides.session,
      sessions: { ...base.session.sessions, ...overrides.session?.sessions }
    },
    ephemeral: challenges ? { challenges } : overrides.ephemeral
  }
}

function beginConfig(options) {
  const now = options.now ?? new Date('2026-01-01T00:00:00.000Z')
  return {
    methods: {
      [options.method.methodId]: options.method
    },
    clock: {
      now() {
        return now
      }
    },
    idGenerator: {
      generate(input) {
        assert.equal(input.kind, 'challenge')
        return 'challenge_1'
      }
    },
    session: {
      defaultTtlSeconds: 3600
    },
    token: {
      async identify() {
        return { ok: true, value: null }
      },
      async issue() {
        throw new Error('token issue should not run')
      }
    },
    store: validStore({
      durable: {
        identities: options.identities,
        accounts: {
          async findById() {
            throw new Error('account lookup should not run')
          }
        }
      },
      session: {
        sessions: {}
      },
      ephemeral: {
        challenges: options.challenges ?? {
          async create() {
            throw new Error('challenge create should not run')
          }
        }
      }
    }),
    guard: options.guard,
    policy: options.policy
  }
}

function challengeMethod(options) {
  return {
    methodId: 'otp.email',
    methodKind: 'otp',
    operations: {
      begin: {
        validate() {
          options.calls.push('validate')
          return {
            ok: true,
            value: {
              value: { lookup: options.lookup },
              lookup: options.lookup,
              publicData: { flow: 'otp' }
            }
          }
        },
        async run(input, context) {
          options.calls.push('run')
          if (options.run) {
            return options.run(input, context)
          }
          return {
            ok: true,
            value: {
              challengeMaterial: { schemaVersion: 'otp.v1' },
              expiresAt: new Date(context.now.getTime() + 300000),
              maxAttempts: 3,
              sideEffects: [],
              publicData: { flow: 'otp' }
            }
          }
        }
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
    scheme: 'test.v1',
    redacted: '[REDACTED]',
    revealForPersistence() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function sealedValue(value) {
  return {
    type: 'sealed-secret',
    algorithm: 'test.v1',
    keyId: 'key_1',
    redacted: '[REDACTED]',
    revealCiphertextForPersistence() {
      return value
    },
    toJSON() {
      return '[REDACTED]'
    }
  }
}

function accountRecord(now) {
  return {
    tenantId: 'tenant_1',
    accountId: 'account_1',
    status: 'active',
    createdAt: now,
    updatedAt: now
  }
}
