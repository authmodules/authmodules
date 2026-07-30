import test from 'node:test'
import assert from 'node:assert/strict'
import { createCookieTokenCarrier } from '../src/index.ts'

test('reads configured cookie into raw secret token', () => {
  const carrier = createCookieTokenCarrier({ name: 'session' })
  const result = carrier.read({ headers: {}, cookies: { session: 'raw-token' } })

  assert.equal(result.ok, true)
  assert.equal(result.value.found, true)
  assert.equal(result.value.token.reveal(), 'raw-token')
  assert.equal(JSON.stringify(result.value).includes('raw-token'), false)
})

test('creates set and clear cookie instructions', () => {
  const expiresAt = new Date('2026-01-01T00:00:00.000Z')
  const carrier = createCookieTokenCarrier({
    name: 'session',
    path: '/auth',
    sameSite: 'strict',
    secure: true
  })

  const set = carrier.createSetInstructions({
    token: rawSecret('raw-token'),
    expiresAt
  })
  const clear = carrier.createClearInstructions()

  assert.equal(set.ok, true)
  assert.equal(set.value[0].cookie.name, 'session')
  assert.notEqual(set.value[0].cookie.expires, expiresAt)
  assert.equal(set.value[0].cookie.expires.toISOString(), '2026-01-01T00:00:00.000Z')
  expiresAt.setUTCFullYear(2099)
  assert.equal(set.value[0].cookie.expires.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(JSON.stringify(set.value).includes('raw-token'), false)
  assert.deepEqual(clear.value[0], {
    type: 'clear-cookie',
    cookie: {
      name: 'session',
      path: '/auth',
      domain: undefined,
      secure: true
    }
  })
})

test('clears prefixed cookies with their required Secure scope', () => {
  const carrier = createCookieTokenCarrier({ name: '__Host-session' })
  const clear = carrier.createClearInstructions()

  assert.equal(clear.ok, true)
  assert.deepEqual(clear.value[0], {
    type: 'clear-cookie',
    cookie: {
      name: '__Host-session',
      path: '/',
      domain: undefined,
      secure: true
    }
  })
})

test('rejects unsafe cookie configuration', () => {
  assert.throws(() => createCookieTokenCarrier({ name: 'session\r\nX-Test' }), /name/)
  assert.throws(() => createCookieTokenCarrier({ path: '/; Domain=evil.test' }), /path/)
  assert.throws(() => createCookieTokenCarrier({ sameSite: 'none', secure: false }), /Secure/)
  assert.throws(() => createCookieTokenCarrier({ path: 'relative' }), /path/)
  assert.throws(() => createCookieTokenCarrier({ path: '/😀' }), /path/)
  assert.throws(() => createCookieTokenCarrier({ domain: 'example.test; Secure' }), /domain/)
  assert.throws(() => createCookieTokenCarrier({ name: '__Secure-session', secure: false }), /__Secure-/)
  assert.throws(() => createCookieTokenCarrier({ name: '__Host-session', path: '/auth' }), /__Host-/)
  assert.throws(() => createCookieTokenCarrier({ name: '__Host-session', domain: 'example.test' }), /__Host-/)
  assert.doesNotThrow(() => createCookieTokenCarrier({ name: '__Host-session' }))
})

test('rejects tokens outside RFC cookie-octet', () => {
  const carrier = createCookieTokenCarrier()
  for (const session of [
    'x'.repeat(8193),
    'safe\u0000unsafe',
    'contains space',
    'contains,comma',
    'contains"quote',
    'contains\\backslash',
    'non-ascii-å'
  ]) {
    const result = carrier.read({ headers: {}, cookies: { am_session: session } })
    assert.equal(result.ok, false)
    assert.equal(result.error.reason, 'VALIDATION_FAILED')
  }
})

test('ignores inherited cookies and maps accessor failures to carrier failures', () => {
  const carrier = createCookieTokenCarrier()
  const inherited = carrier.read({ headers: {}, cookies: Object.create({ am_session: 'injected' }) })
  const throwing = carrier.read({
    headers: {},
    cookies: Object.defineProperty({}, 'am_session', {
      enumerable: true,
      get() {
        throw new Error('access denied')
      }
    })
  })

  assert.deepEqual(inherited, { ok: true, value: { found: false } })
  assert.equal(throwing.ok, false)
  assert.equal(throwing.error.reason, 'VALIDATION_FAILED')
})

test('maps malformed request and set inputs to carrier failures', () => {
  const carrier = createCookieTokenCarrier()
  // @ts-expect-error Runtime validation must fail closed for untyped callers.
  const missingRequest = carrier.read()
  // @ts-expect-error Runtime validation must fail closed for malformed cookie maps.
  const invalidCookie = carrier.read({ headers: {}, cookies: { am_session: ['token'] } })
  const missingToken = carrier.createSetInstructions()
  const invalidExpiry = carrier.createSetInstructions({
    token: rawSecret('token'),
    expiresAt: new Date('invalid')
  })
  const incompleteToken = carrier.createSetInstructions({
    token: { reveal: () => 'token', toJSON: () => '[REDACTED]' }
  })
  const invalidTokenValue = carrier.createSetInstructions({ token: rawSecret('x'.repeat(4097)) })

  for (const result of [
    missingRequest,
    invalidCookie,
    missingToken,
    invalidExpiry,
    incompleteToken,
    invalidTokenValue
  ]) {
    assert.equal(result.ok, false)
    assert.equal(result.error.component, 'carrier')
    assert.equal(result.error.reason, 'VALIDATION_FAILED')
  }
})

test('rejects cookie set values outside RFC cookie-octet', () => {
  const carrier = createCookieTokenCarrier()

  for (const value of [
    'contains space',
    'contains,comma',
    'contains"quote',
    'contains\\backslash',
    'non-ascii-å'
  ]) {
    const result = carrier.createSetInstructions({ token: rawSecret(value) })
    assert.equal(result.ok, false)
    assert.equal(result.error.reason, 'VALIDATION_FAILED')
  }
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
