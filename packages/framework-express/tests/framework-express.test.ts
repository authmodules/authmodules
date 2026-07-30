import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyHttpMutations,
  createExpressAuthAdapter,
  revealSecretHttpValue,
  toAuthContext,
  toHttpRequestView
} from '../src/index.ts'

test('normalizes request headers and builds auth context', () => {
  const req = {
    headers: {
      'X-Request-Id': 'req_1',
      'User-Agent': 'node-test',
      'Accept-Language': 'en'
    },
    cookies: { session: 'token' },
    ip: '127.0.0.1'
  }

  assert.deepEqual(toHttpRequestView(req), {
    headers: {
      'x-request-id': 'req_1',
      'user-agent': 'node-test',
      'accept-language': 'en'
    },
    cookies: { session: 'token' }
  })
  assert.deepEqual(toAuthContext(req, 'tenant_1'), {
    tenantId: 'tenant_1',
    requestId: 'req_1',
    ip: '127.0.0.1',
    userAgent: 'node-test',
    locale: 'en',
    actor: undefined,
    metadata: undefined,
    policyInput: undefined
  })
})

test('applies headers and cookies while revealing secrets only at response boundary', () => {
  const res = memoryResponse()
  applyHttpMutations(res, [
    {
      type: 'set-header',
      name: 'x-auth-token',
      value: { parts: ['Bearer ', rawSecret('header-token')] }
    },
    {
      type: 'set-cookie',
      cookie: {
        name: 'session',
        value: rawSecret('cookie-token'),
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax'
      }
    },
    {
      type: 'clear-cookie',
      cookie: {
        name: 'legacy',
        path: '/'
      }
    },
    {
      type: 'clear-cookie',
      cookie: {
        name: '__Host-session',
        path: '/',
        secure: true
      }
    }
  ])

  assert.equal(res.headers.get('x-auth-token'), 'Bearer header-token')
  assert.deepEqual(res.headers.get('set-cookie'), [
    'session=cookie-token; Path=/; HttpOnly; Secure; SameSite=Lax',
    'legacy=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
    '__Host-session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure'
  ])
  assert.equal(revealSecretHttpValue({ parts: ['Bearer ', rawSecret('other-token')] }), 'Bearer other-token')
})

test('adapter resolves token and delegates getSession', async () => {
  const adapter = createExpressAuthAdapter({
    tenantResolver: () => 'tenant_1',
    carrier: {
      read(input) {
        return { ok: true, value: { found: true, token: rawSecret(input.cookies.session) } }
      }
    },
    auth: {
      async getSession(input) {
        assert.equal(input.context.tenantId, 'tenant_1')
        assert.equal(input.token.reveal(), 'raw-token')
        return { ok: true, value: { sessionId: 'session_1' } }
      }
    }
  })

  const result = await adapter.getSession({
    headers: {},
    cookies: { session: 'raw-token' }
  })
  const context = adapter.toAuthContext({
    headers: {},
    authActor: { type: 'account', accountId: 'account_1' },
    authMetadata: { source: 'test' }
  })
  const request = adapter.toHttpRequestView({ headers: { 'X-Test': 'value' } })
  const response = memoryResponse()
  adapter.applyHttpMutations(response, [{
    type: 'set-header',
    name: 'x-adapter-test',
    value: { parts: ['value'] }
  }])

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { sessionId: 'session_1' })
  assert.deepEqual(context.actor, { type: 'account', accountId: 'account_1' })
  assert.deepEqual(context.metadata, { source: 'test' })
  assert.equal(request.headers['x-test'], 'value')
  assert.equal(response.headers.get('x-adapter-test'), 'value')
  assert.equal(adapter.publicError({ publicError: { code: 'INVALID_INPUT' } }).code, 'INVALID_INPUT')
})

test('adapter requires explicit tenant resolution and rejects header injection', () => {
  assert.throws(() => createExpressAuthAdapter(), /options/)
  assert.throws(
    () => createExpressAuthAdapter({ auth: { getSession() {} }, carrier: { read() {} } }),
    /tenantResolver/
  )
  assert.throws(
    () => applyHttpMutations(memoryResponse(), [{
      type: 'set-header',
      name: 'x-auth-token',
      value: { parts: [rawSecret('safe\r\nX-Evil: true')] }
    }]),
    /header value/
  )
  assert.throws(
    () => applyHttpMutations(memoryResponse(), [{
      type: 'set-header',
      name: 'x-auth-token',
      value: { parts: [rawSecret('safe\u0001unsafe')] }
    }]),
    /header value/
  )
  assert.throws(
    () => applyHttpMutations(memoryResponse(), [{
      type: 'set-header',
      name: 'x-auth-token',
      value: { parts: [rawSecret('safe\u0100unsafe')] }
    }]),
    /header value/
  )
  assert.throws(
    () => applyHttpMutations(memoryResponse(), [{
      type: 'set-header',
      name: 'x-auth-token',
      value: { parts: [rawSecret('x'.repeat(8193))] }
    }]),
    /too large/
  )
})

test('rejects malformed inbound headers, cookies, and auth context data', () => {
  const cyclic = {}
  cyclic.self = cyclic

  assert.throws(
    () => toHttpRequestView({ headers: { 'x-request-id': 'safe\r\ninjected' } }),
    /headers/
  )
  assert.throws(
    () => toHttpRequestView({ headers: { 'x-request-id': 'safe\u0001unsafe' } }),
    /headers/
  )
  assert.throws(
    () => toHttpRequestView({ headers: { 'x-request-id': { nested: true } } }),
    /headers/
  )
  assert.throws(
    () => toHttpRequestView({
      headers: {
        Authorization: 'Bearer first',
        authorization: 'Bearer second'
      }
    }),
    /ambiguous/
  )
  assert.throws(
    () => toHttpRequestView({ cookies: { session: 'x'.repeat(8193) } }),
    /cookies/
  )
  assert.throws(
    () => toHttpRequestView({ cookies: { session: 'safe\u0000unsafe' } }),
    /cookies/
  )
  assert.throws(
    () => toAuthContext({ headers: {}, authMetadata: cyclic }, 'tenant_1'),
    /auth data/
  )
  assert.throws(
    () => toAuthContext({ headers: {}, authActor: { type: 'account', accountId: '' } }, 'tenant_1'),
    /actor/
  )
  assert.throws(
    () => toAuthContext({
      headers: {},
      authActor: { type: 'account', accountId: 'account_1', privateValue: 'must-not-cross' }
    }, 'tenant_1'),
    /actor/
  )
  assert.throws(
    () => toAuthContext({
      headers: {},
      authMetadata: { verifier: { type: 'protected-value', value: 'must-not-cross' } }
    }, 'tenant_1'),
    /auth data/
  )
  assert.throws(
    () => toAuthContext({ headers: { 'x-request-id': 'x'.repeat(513) } }, 'tenant_1'),
    /x-request-id/
  )
})

test('auth context owns snapshots of request metadata and policy input', () => {
  const metadata = { nested: { source: 'original' } }
  const policyInput = { roles: ['user'] }
  const context = toAuthContext({
    headers: {},
    authMetadata: metadata,
    authPolicyInput: policyInput
  }, 'tenant_1')

  metadata.nested.source = 'mutated'
  policyInput.roles.push('admin')

  assert.deepEqual(context.metadata, { nested: { source: 'original' } })
  assert.deepEqual(context.policyInput, { roles: ['user'] })
  assert.notEqual(context.metadata, metadata)
  assert.notEqual(context.policyInput, policyInput)
})

test('auth context reads stateful request and actor fields once', () => {
  let headersReads = 0
  let actorReads = 0
  let accountIdReads = 0
  const actor = Object.defineProperty({
    type: 'account'
  }, 'accountId', {
    enumerable: true,
    get() {
      accountIdReads += 1
      return accountIdReads === 1 ? 'account_1' : ''
    }
  })
  const request = Object.defineProperties({}, {
    headers: {
      enumerable: true,
      get() {
        headersReads += 1
        return headersReads === 1 ? { 'x-request-id': 'request_1' } : { 'x-request-id': 'mutated' }
      }
    },
    authActor: {
      enumerable: true,
      get() {
        actorReads += 1
        return actorReads === 1 ? actor : { type: 'anonymous' }
      }
    }
  }) as Parameters<typeof toAuthContext>[0]

  const context = toAuthContext(request, 'tenant_1')

  assert.equal(headersReads, 1)
  assert.equal(actorReads, 1)
  assert.equal(accountIdReads, 1)
  assert.equal(context.requestId, 'request_1')
  assert.deepEqual(context.actor, { type: 'account', accountId: 'account_1' })
})

test('rejects malformed cookie descriptors and unknown mutations', () => {
  const value = rawSecret('token')
  for (const cookie of [
    { name: 'session\r\nX-Evil', value },
    { name: 'session', value, path: '/; Domain=evil.test' },
    { name: 'session', value, path: '/😀' },
    { name: 'session', value, domain: 'example.test; Secure' },
    { name: 'session', value, maxAgeSeconds: 1.5 },
    { name: 'session', value, sameSite: 'none', secure: false },
    { name: 'session', value, expires: new Date('invalid') },
    { name: 'session', value: rawSecret('\ud800') }
  ]) {
    assert.throws(
      () => applyHttpMutations(memoryResponse(), [{ type: 'set-cookie', cookie }]),
      /Cookie|SameSite/
    )
  }

  assert.throws(
    () => applyHttpMutations(memoryResponse(), [{ type: 'unknown' }]),
    /mutation type/
  )
  assert.throws(
    () => revealSecretHttpValue({ parts: [{ reveal: () => 123 }] }),
    /value part/
  )
})

test('cookie serialization snapshots stateful set and clear descriptors once', () => {
  let setNameReads = 0
  let setDomainReads = 0
  let clearNameReads = 0
  const response = memoryResponse()
  const setCookie = {
    get name() {
      setNameReads += 1
      return setNameReads === 1 ? 'session' : 'session\r\nX-Evil'
    },
    value: rawSecret('safe-token'),
    path: '/',
    secure: true,
    get domain() {
      setDomainReads += 1
      return setDomainReads === 1 ? undefined : 'attacker.test; injected=token'
    }
  }
  const clearCookie = {
    get name() {
      clearNameReads += 1
      return clearNameReads === 1 ? 'legacy' : 'legacy\r\nX-Evil'
    },
    path: '/'
  }

  applyHttpMutations(response, [
    { type: 'set-cookie', cookie: setCookie },
    { type: 'clear-cookie', cookie: clearCookie }
  ])

  assert.deepEqual(response.headers.get('set-cookie'), [
    'session=safe-token; Path=/; HttpOnly; Secure',
    'legacy=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'
  ])
  assert.equal(setNameReads, 1)
  assert.equal(setDomainReads, 1)
  assert.equal(clearNameReads, 1)
})

test('validates the complete mutation batch before changing the response', () => {
  const res = memoryResponse()

  assert.throws(() => applyHttpMutations(res, [
    {
      type: 'set-header',
      name: 'x-auth-token',
      value: { parts: ['safe'] }
    },
    {
      type: 'set-cookie',
      cookie: { name: 'session', value: rawSecret('safe\u0000unsafe') }
    }
  ]), /Cookie value/)

  assert.equal(res.headers.size, 0)

  const headerRes = memoryResponse()
  assert.throws(() => applyHttpMutations(headerRes, [
    {
      type: 'set-header',
      name: 'x-valid',
      value: { parts: ['safe'] }
    },
    {
      type: 'set-header',
      name: 'x-invalid',
      value: { parts: ['safe\u0001unsafe'] }
    }
  ]), /header value/)
  assert.equal(headerRes.headers.size, 0)
})

test('stops revealing header parts when the cumulative limit is exceeded', () => {
  let extraRevealCalls = 0
  const extra = rawSecret('ignored')
  extra.reveal = () => {
    extraRevealCalls += 1
    return 'ignored'
  }

  assert.throws(() => revealSecretHttpValue({
    parts: ['x'.repeat(8192), rawSecret('overflow'), extra]
  }), /too large/)
  assert.equal(extraRevealCalls, 0)
})

test('secret HTTP values iterate over one snapshot of parts', () => {
  const parts = []
  const first = rawSecret('first')
  first.reveal = () => {
    parts.push(...Array.from({ length: 101 }, () => 'injected'))
    return 'first'
  }
  parts.push(first, '-last')

  assert.equal(revealSecretHttpValue({ parts }), 'first-last')
})

test('adapter maps thrown or malformed carrier results without rejecting', async () => {
  const thrown = createExpressAuthAdapter({
    tenantResolver: () => 'tenant_1',
    carrier: { read() { throw new Error('bad carrier') } },
    auth: { async getSession() { throw new Error('must not run') } }
  })
  const malformed = createExpressAuthAdapter({
    tenantResolver: () => 'tenant_1',
    carrier: { read() { return { ok: true, value: { found: true } } } },
    auth: { async getSession() { throw new Error('must not run') } }
  })
  const malformedFailure = createExpressAuthAdapter({
    tenantResolver: () => 'tenant_1',
    carrier: {
      read() {
        return {
          ok: false,
          error: { type: 'component.failure', component: 'store', reason: 'STORE_UNAVAILABLE' }
        }
      }
    },
    auth: { async getSession() { throw new Error('must not run') } }
  })
  const carrierFailure = createExpressAuthAdapter({
    tenantResolver: () => 'tenant_1',
    carrier: {
      read() {
        return {
          ok: false,
          error: {
            type: 'component.failure',
            component: 'carrier',
            reason: 'CARRIER_FAILED',
            details: { nested: ['safe', 1, true, null] }
          }
        }
      }
    },
    auth: { async getSession() { throw new Error('must not run') } }
  })

  assert.equal(thrown.readToken({ headers: {} }).error.reason, 'INTERNAL')
  assert.deepEqual(carrierFailure.readToken({ headers: {} }), {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'carrier',
      reason: 'CARRIER_FAILED',
      details: { nested: ['safe', 1, true, null] }
    }
  })
  const thrownSession = await thrown.getSession({ headers: {} })
  const malformedSession = await malformed.getSession({ headers: {} })
  const malformedFailureSession = await malformedFailure.getSession({ headers: {} })
  assert.equal(thrownSession.ok, false)
  assert.equal(thrownSession.error.internalReason, 'INTERNAL')
  assert.equal(malformedSession.ok, false)
  assert.equal(malformedSession.error.internalReason, 'VALIDATION_FAILED')
  assert.equal(malformedFailureSession.error.internalReason, 'VALIDATION_FAILED')
})

test('adapter snapshots carrier secrets before returning them', () => {
  const leaking = createExpressAuthAdapter({
    tenantResolver: () => 'tenant_1',
    carrier: {
      read() {
        return {
          ok: true,
          value: {
            found: true,
            token: {
              type: 'raw-secret',
              redacted: '[UNTRUSTED]',
              reveal() {
                return 'carrier-secret'
              },
              toJSON() {
                return 'carrier-secret'
              }
            }
          }
        }
      }
    },
    auth: { async getSession() { throw new Error('must not run') } }
  })

  const result = leaking.readToken({ headers: {} })
  assert.equal(result.ok, true)
  assert.equal(result.value.token.reveal(), 'carrier-secret')
  assert.equal(JSON.stringify(result).includes('carrier-secret'), false)
  assert.equal(Object.isFrozen(result.value.token), true)
})

function memoryResponse() {
  const headers = new Map()
  return {
    headers,
    getHeader(name) {
      return headers.get(name)
    },
    setHeader(name, value) {
      headers.set(name, value)
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
