import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryAttemptGuard } from '../src/index.ts'
import {
  snapshotMemoryAttemptGuardAttemptsForTesting
} from '../src/guard/create-memory-attempt-guard.ts'

test('allows attempts until failure threshold is reached', async () => {
  const guard = createMemoryAttemptGuard({
    maxFailures: 2,
    windowSeconds: 60,
    retryAfterSeconds: 10
  })
  const input = attemptInput()

  const first = await guard.beforeAttempt(input)
  assert.deepEqual(first, { ok: true, value: { allow: true } })

  await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'PASSWORD_MISMATCH', countsAsAttempt: true } })
  await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'PASSWORD_MISMATCH', countsAsAttempt: true } })

  const limited = await guard.beforeAttempt(input)
  assert.equal(limited.ok, true)
  assert.deepEqual(limited.value, {
    allow: false,
    reason: 'RATE_LIMITED',
    publicCodeHint: 'RATE_LIMITED',
    retryAfterSeconds: 10
  })
})

test('successful attempt clears stored failures', async () => {
  const guard = createMemoryAttemptGuard({ maxFailures: 1 })
  const input = attemptInput()

  await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  assert.equal((await guard.beforeAttempt(input)).value.allow, false)

  await guard.afterAttempt({ ...input, outcome: { success: true } })
  assert.equal((await guard.beforeAttempt(input)).value.allow, true)
})

test('complete attempts are isolated by challengeId', async () => {
  const guard = createMemoryAttemptGuard({ maxFailures: 1 })
  const first = { ...attemptInput(), operation: 'complete', challengeId: 'challenge_a' }
  const second = { ...attemptInput(), operation: 'complete', challengeId: 'challenge_b' }

  await guard.afterAttempt({
    ...first,
    outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true }
  })

  assert.equal((await guard.beforeAttempt(first)).value.allow, false)
  assert.equal((await guard.beforeAttempt(second)).value.allow, true)
})

test('infrastructure and rate-limit outcomes do not extend lockout windows', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z')
  const guard = createMemoryAttemptGuard({
    maxFailures: 1,
    windowSeconds: 10,
    now: () => now
  })
  const input = attemptInput()

  await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'STORE_UNAVAILABLE', countsAsAttempt: false } })
  assert.equal((await guard.beforeAttempt(input)).value.allow, true)

  await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'PASSWORD_MISMATCH', countsAsAttempt: true } })
  assert.equal((await guard.beforeAttempt(input)).value.allow, false)
  now = new Date('2026-01-01T00:00:05.000Z')
  await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'RATE_LIMITED', countsAsAttempt: false } })
  now = new Date('2026-01-01T00:00:10.000Z')
  assert.equal((await guard.beforeAttempt(input)).value.allow, true)
})

test('uses explicit attempt counting for custom and standard reasons', async () => {
  const guard = createMemoryAttemptGuard({ maxFailures: 1 })
  const input = attemptInput()

  await guard.afterAttempt({
    ...input,
    outcome: { success: false, reason: 'PASSWORD_MISMATCH', countsAsAttempt: false }
  })
  assert.equal((await guard.beforeAttempt(input)).value.allow, true)

  await guard.afterAttempt({
    ...input,
    outcome: { success: false, reason: 'custom.invalid-secret', countsAsAttempt: true }
  })
  assert.equal((await guard.beforeAttempt(input)).value.allow, false)
})

test('uses the injected clock and expires failures at the window boundary', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z')
  const guard = createMemoryAttemptGuard({
    maxFailures: 1,
    windowSeconds: 10,
    now: () => now
  })
  const input = attemptInput()

  await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  assert.equal((await guard.beforeAttempt(input)).value.allow, false)

  now = new Date('2026-01-01T00:00:10.000Z')
  assert.equal((await guard.beforeAttempt(input)).value.allow, true)
  assert.equal(snapshotMemoryAttemptGuardAttemptsForTesting(guard).size, 0)
})

test('keeps only unexpired timestamps when the oldest failure reaches the window boundary', async () => {
  let now = 0
  const guard = createMemoryAttemptGuard({
    maxFailures: 3,
    windowSeconds: 10,
    now: () => now
  })
  const input = attemptInput()

  await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  now = 5_000
  await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  now = 10_000

  assert.equal((await guard.beforeAttempt(input)).value.allow, true)
  assert.deepEqual([...snapshotMemoryAttemptGuardAttemptsForTesting(guard).values()], [[5_000]])
})

test('compacts stale expiration entries without changing the active failure window', async () => {
  const guard = createMemoryAttemptGuard({
    maxFailures: 6,
    maxKeys: 1,
    windowSeconds: 60,
    now: () => 0
  })
  const input = attemptInput()

  for (let index = 0; index < 5; index += 1) {
    await guard.afterAttempt({ ...input, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  }

  assert.deepEqual(
    [...snapshotMemoryAttemptGuardAttemptsForTesting(guard).values()],
    [[0, 0, 0, 0, 0]]
  )
  assert.equal((await guard.beforeAttempt(input)).value.allow, true)
})

test('prunes multiple keys in expiration order', async () => {
  let now = 0
  const guard = createMemoryAttemptGuard({
    maxFailures: 1,
    maxKeys: 3,
    windowSeconds: 100,
    now: () => now
  })
  const first = attemptInput()
  const second = { ...attemptInput(), context: { tenantId: 'tenant_2' } }
  const third = { ...attemptInput(), context: { tenantId: 'tenant_3' } }

  await guard.afterAttempt({ ...first, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  now = 5_000
  await guard.afterAttempt({ ...second, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  now = 10_000
  await guard.afterAttempt({ ...third, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  now = 100_000

  assert.equal((await guard.beforeAttempt(first)).value.allow, true)
  assert.equal(snapshotMemoryAttemptGuardAttemptsForTesting(guard).size, 2)
})

test('bounds distinct attempt keys and evicts the least recently updated key', async () => {
  const guard = createMemoryAttemptGuard({ maxFailures: 1, maxKeys: 2 })
  const first = attemptInput()
  const second = { ...attemptInput(), context: { tenantId: 'tenant_2' } }
  const third = { ...attemptInput(), context: { tenantId: 'tenant_3' } }

  await guard.afterAttempt({ ...first, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  await guard.afterAttempt({ ...second, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })
  await guard.afterAttempt({ ...third, outcome: { success: false, reason: 'OTP_MISMATCH', countsAsAttempt: true } })

  assert.equal(snapshotMemoryAttemptGuardAttemptsForTesting(guard).size, 2)
  assert.equal((await guard.beforeAttempt(first)).value.allow, true)
  assert.equal((await guard.beforeAttempt(second)).value.allow, false)
  assert.equal((await guard.beforeAttempt(third)).value.allow, false)
})

test('rejects invalid guard limits', () => {
  assert.throws(() => createMemoryAttemptGuard({ maxFailures: 0 }), /maxFailures/)
  assert.throws(() => createMemoryAttemptGuard({ maxFailures: 1001 }), /maxFailures/)
  assert.throws(() => createMemoryAttemptGuard({ windowSeconds: 0 }), /windowSeconds/)
  assert.throws(() => createMemoryAttemptGuard({ maxKeys: 0 }), /maxKeys/)
  assert.throws(() => createMemoryAttemptGuard({ maxKeys: 100001 }), /maxKeys/)
})

test('maps malformed input and invalid injected clock to guard failures', async () => {
  const guard = createMemoryAttemptGuard()
  const malformed = await guard.beforeAttempt({})
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error.reason, 'VALIDATION_FAILED')

  const invalidClock = createMemoryAttemptGuard({ now: () => new Date('invalid') })
  const failedClock = await invalidClock.beforeAttempt(attemptInput())
  const failedAfterAttempt = await invalidClock.afterAttempt({
    ...attemptInput(),
    outcome: { success: false, reason: 'PASSWORD_MISMATCH', countsAsAttempt: true }
  })
  assert.equal(failedClock.ok, false)
  assert.equal(failedClock.error.reason, 'INTERNAL')
  assert.equal(failedAfterAttempt.ok, false)
  assert.equal(failedAfterAttempt.error.reason, 'INTERNAL')
})

test('rejects oversized and control-bearing attempt keys', async () => {
  const guard = createMemoryAttemptGuard()
  const oversizedTenant = await guard.beforeAttempt({
    ...attemptInput(),
    context: { tenantId: 't'.repeat(513) }
  })
  const oversizedSubject = await guard.beforeAttempt({
    ...attemptInput(),
    lookup: { ...attemptInput().lookup, subject: 's'.repeat(2049) }
  })
  const controlCharacter = await guard.beforeAttempt({
    ...attemptInput(),
    challengeId: 'challenge\nmalformed'
  })
  const oversizedReason = await guard.afterAttempt({
    ...attemptInput(),
    outcome: { success: false, reason: 'R'.repeat(513), countsAsAttempt: true }
  })

  for (const result of [oversizedTenant, oversizedSubject, controlCharacter, oversizedReason]) {
    assert.equal(result.ok, false)
    assert.equal(result.error.reason, 'VALIDATION_FAILED')
  }
})

test('maps null lookup to validation failures without rejecting', async () => {
  const guard = createMemoryAttemptGuard()
  const input = { ...attemptInput(), lookup: null }

  const before = await guard.beforeAttempt(input)
  const after = await guard.afterAttempt({
    ...input,
    outcome: { success: false, reason: 'PASSWORD_MISMATCH', countsAsAttempt: true }
  })

  assert.equal(before.ok, false)
  assert.equal(before.error.reason, 'VALIDATION_FAILED')
  assert.equal(after.ok, false)
  assert.equal(after.error.reason, 'VALIDATION_FAILED')
})

test('maps hostile input accessors to validation failures without rejecting', async () => {
  const guard = createMemoryAttemptGuard()
  const input = new Proxy({}, {
    get() {
      throw new Error('hostile getter')
    }
  })

  const before = await guard.beforeAttempt(input)
  const after = await guard.afterAttempt(input)

  assert.equal(before.ok, false)
  assert.equal(before.error.reason, 'VALIDATION_FAILED')
  assert.equal(after.ok, false)
  assert.equal(after.error.reason, 'VALIDATION_FAILED')
})

test('uses collision-free structured attempt keys', async () => {
  const guard = createMemoryAttemptGuard({ maxFailures: 1 })
  const first = {
    ...attemptInput(),
    lookup: { ...attemptInput().lookup, subject: 'user:example.test' }
  }
  const second = {
    ...attemptInput(),
    lookup: {
      methodId: 'password.email:password',
      methodKind: 'email',
      subjectKind: 'user',
      subject: 'example.test'
    }
  }
  await guard.afterAttempt({ ...first, outcome: { success: false, reason: 'PASSWORD_MISMATCH', countsAsAttempt: true } })
  assert.equal((await guard.beforeAttempt(first)).value.allow, false)
  assert.equal((await guard.beforeAttempt(second)).value.allow, true)
})

function attemptInput() {
  return {
    context: { tenantId: 'tenant_1' },
    method: { methodId: 'password.email', methodKind: 'password' },
    operation: 'authenticate',
    lookup: {
      methodId: 'password.email',
      methodKind: 'password',
      subjectKind: 'email',
      subject: 'user@example.test'
    }
  }
}
