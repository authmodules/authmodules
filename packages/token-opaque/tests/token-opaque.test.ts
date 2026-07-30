import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpaqueTokenFormat } from '../src/index.ts'

test('issues opaque token with protected token hash', async () => {
  const token = createOpaqueTokenFormat({ crypto: fakeCrypto(), bytes: 16, scheme: 'test-token.v1' })
  const result = await token.issue(issueInput())

  assert.equal(result.ok, true)
  assert.equal(result.value.raw.reveal(), 'A'.repeat(22))
  assert.equal(result.value.tokenHash.scheme, 'test-token.v1')
  assert.equal(result.value.tokenHash.revealForPersistence(), `hash:${'A'.repeat(22)}`)
  assert.equal(JSON.stringify(result.value).includes('A'.repeat(22)), false)
})

test('normalizes crypto raw-secret wrappers before returning them', async () => {
  const secretValue = 'S'.repeat(22)
  const token = createOpaqueTokenFormat({
    bytes: 16,
    crypto: {
      ...fakeCrypto(),
      randomSecretString() {
        return {
          type: 'raw-secret',
          redacted: secretValue,
          reveal() {
            return secretValue
          },
          toJSON() {
            return secretValue
          }
        }
      }
    }
  })

  const result = await token.issue(issueInput())
  assert.equal(result.ok, true)
  assert.equal(result.value.raw.reveal(), secretValue)
  assert.equal(JSON.stringify(result).includes(secretValue), false)
  assert.equal(result.value.raw.toJSON(), '[REDACTED]')
})

test('snapshots stateful crypto token hashes before returning them', async () => {
  let reads = 0
  let dateReads = 0
  class StatefulDate extends Date {
    getTime() {
      dateReads += 1
      return dateReads === 1 ? super.getTime() : Number.NaN
    }
  }
  const token = createOpaqueTokenFormat({
    bytes: 16,
    scheme: 'test-token.v1',
    crypto: {
      ...fakeCrypto(),
      async hash() {
        return {
          ok: true,
          value: {
            type: 'protected-value',
            scheme: 'test-token.v1',
            redacted: 'hash=safe-hash',
            createdAt: new StatefulDate('2026-01-01T00:00:00.000Z'),
            revealForPersistence() {
              reads += 1
              return reads === 1 ? 'safe-hash' : 'changed-hash'
            },
            toJSON() {
              return 'hash=safe-hash'
            }
          }
        }
      }
    }
  })

  const result = await token.issue(issueInput())

  assert.equal(result.ok, true)
  assert.equal(reads, 1)
  assert.equal(result.value.tokenHash.revealForPersistence(), 'safe-hash')
  assert.equal(result.value.tokenHash.revealForPersistence(), 'safe-hash')
  assert.equal(result.value.tokenHash.createdAt.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(dateReads, 0)
  assert.equal(JSON.stringify(result.value.tokenHash), '"[REDACTED]"')
  assert.equal(Object.isFrozen(result.value.tokenHash), true)
})

test('identifies opaque token by protected token hash', async () => {
  const token = createOpaqueTokenFormat({ crypto: fakeCrypto(), scheme: 'test-token.v1' })
  const result = await token.identify({
    raw: rawSecret('A'.repeat(43)),
    expectedTenantId: 'tenant_1',
    now: new Date('2026-01-01T00:00:00.000Z')
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.kind, 'by-token-hash')
  assert.equal(result.value.tokenHash.revealForPersistence(), `hash:${'A'.repeat(43)}`)
})

test('maps thrown crypto errors to token failure results', async () => {
  const token = createOpaqueTokenFormat({
    crypto: {
      randomSecretString() {
        throw new Error('rng unavailable')
      },
      async hash() {
        throw new Error('hash unavailable')
      }
    }
  })

  const issued = await token.issue(issueInput())
  const identified = await token.identify({
    raw: rawSecret('A'.repeat(43)),
    expectedTenantId: 'tenant_1',
    now: new Date('2026-01-01T00:00:00.000Z')
  })

  assert.equal(issued.ok, false)
  assert.equal(issued.error.component, 'token')
  assert.equal(issued.error.reason, 'CRYPTO_FAILED')
  assert.equal(identified.ok, false)
  assert.equal(identified.error.component, 'token')
  assert.equal(identified.error.reason, 'CRYPTO_FAILED')
})

test('maps hostile issue dates to token failures without rejecting', async () => {
  class HostileDate extends Date {
    override getTime(): number {
      throw new Error('hostile getTime')
    }
  }
  const token = createOpaqueTokenFormat({ crypto: fakeCrypto() })

  const result = await token.issue({
    ...issueInput(),
    issuedAt: new HostileDate('invalid')
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.component, 'token')
  assert.equal(result.error.reason, 'TOKEN_INVALID')
})

test('rejects weak configuration and treats malformed presented tokens as anonymous', async () => {
  assert.throws(() => createOpaqueTokenFormat(), /options/)
  assert.throws(() => createOpaqueTokenFormat({ crypto: fakeCrypto(), bytes: 8 }), /byte length/)
  assert.throws(() => createOpaqueTokenFormat({ crypto: fakeCrypto(), scheme: 'mutable' }), /versioned/)
  assert.throws(() => createOpaqueTokenFormat({ crypto: fakeCrypto(), scheme: `${'a'.repeat(254)}.v1` }), /versioned/)

  const token = createOpaqueTokenFormat({ crypto: fakeCrypto() })
  assert.deepEqual(await token.identify({ raw: 'not-a-secret' }), { ok: true, value: null })
  assert.deepEqual(await token.identify({
    raw: rawSecret('A'.repeat(10_000)),
    expectedTenantId: 'tenant_1',
    now: new Date('2026-01-01T00:00:00.000Z')
  }), { ok: true, value: null })
  assert.deepEqual(await token.identify({
    raw: rawSecret('+'.repeat(43)),
    expectedTenantId: 'tenant_1',
    now: new Date('2026-01-01T00:00:00.000Z')
  }), { ok: true, value: null })
  assert.deepEqual(await token.identify({
    raw: {
      type: 'raw-secret',
      redacted: '[REDACTED]',
      reveal() { throw new Error('malformed token') },
      toJSON() { return '[REDACTED]' }
    },
    expectedTenantId: 'tenant_1',
    now: new Date('2026-01-01T00:00:00.000Z')
  }), { ok: true, value: null })
})

test('rejects malformed crypto success wrappers', async () => {
  const malformedRaw = createOpaqueTokenFormat({
    crypto: {
      randomSecretString() {
        return { reveal: () => 'A'.repeat(43), toJSON: () => '[REDACTED]' }
      },
      async hash() {
        throw new Error('hash must not run')
      }
    }
  })
  const malformedHash = createOpaqueTokenFormat({
    crypto: {
      ...fakeCrypto(),
      async hash() {
        return {
          ok: true,
          value: {
            scheme: 'opaque-token-sha256.v1',
            revealForPersistence: () => 'hash',
            toJSON: () => '[REDACTED]'
          }
        }
      }
    }
  })

  assert.equal((await malformedRaw.issue(issueInput())).ok, false)
  assert.equal((await malformedHash.issue(issueInput())).ok, false)
})

function fakeCrypto() {
  return {
    randomSecretString(input) {
      return rawSecret('A'.repeat(Math.ceil(input.bytes * 4 / 3)))
    },
    async hash(input) {
      return {
        ok: true,
        value: protectedValue(`hash:${input.value.reveal()}`, input.scheme)
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

function issueInput() {
  return {
    tenantId: 'tenant_1',
    accountId: 'account_1',
    sessionId: 'session_1',
    issuedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-01T01:00:00.000Z')
  }
}
