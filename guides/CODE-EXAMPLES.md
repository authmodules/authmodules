# Code examples

These examples are non-normative. They illustrate the standard shape.

## Composition root

```ts
const stores = createPostgresAuthOutboxStores({ client: postgresClient })
const smtpTransport = createSmtpDeliveryTransport({
  now: () => clock.now(),
  from: 'no-reply@example.com',
  render,
  client: smtpClient,
})

const authResult = createAuth({
  store: stores.auth,

  methods: {
    'password.email': createPasswordMethod({
      methodId: 'password.email',
      passwordHasher,
    }),

    'otp.email': createOtpMethod({
      methodId: 'otp.email',
      crypto,
      verificationKey: secretFactory.raw(otpHmacKey),
      ttlSeconds: 300,
    }),
  },

  token: createOpaqueTokenFormat({ crypto }),

  session: {
    defaultTtlSeconds: 60 * 60 * 24 * 7,
    maxTtlSeconds: 60 * 60 * 24 * 30,
  },

  effects: createOutboxEffectsDispatcher({
    store: stores.outbox,
    sealer: outboxSealer,
    idGenerator: ({ tenantId, now }) =>
      idGenerator.generate({ kind: 'outbox-message', tenantId, now }),
  }),

  policy: async check => {
    if (check.kind === 'start-attempt' && check.lookup?.subject.endsWith('@example.org')) {
      return { allow: false, reason: 'POLICY_DENIED', publicCodeHint: 'AUTHORIZATION_FAILED' }
    }
    return { allow: true }
  },

  clock,
  idGenerator,
})

if (!authResult.ok) throw new Error('Invalid auth config')
const auth = authResult.value

const outboxWorker = createOutboxWorker({
  store: stores.outbox,
  transport: smtpTransport,
  sealer: outboxSealer,
  workerId: 'delivery-worker-1',
})

const expressAuth = createExpressAuthAdapter({
  auth,
  carrier: createCookieTokenCarrier({ name: '__Host-am_session' }),
  tenantResolver: resolveTenantFromTrustedRoute,
})
```

## Generic ID generation

```ts
import { randomUUID } from 'node:crypto'

const idGenerator = {
  generate({ kind, tenantId, now }) {
    return `${kind}_${randomUUID()}`
  },
}

const accountId = idGenerator.generate({ kind: 'account', tenantId: context.tenantId, now })
const challengeId = idGenerator.generate({ kind: 'challenge', tenantId: context.tenantId, now })
const messageId = idGenerator.generate({ kind: 'outbox-message', tenantId, now }) // extension use
```

## Password sign-in

```ts
const result = await auth.authenticate({
  context: {
    tenantId: 'default',
    requestId: 'req_1',
    actor: { type: 'anonymous' },
  },
  methodId: 'password.email',
  input: {
    subject: 'ada@example.com',
    password: secretFactory.raw('correct horse battery staple'),
  },
  session: {}, // uses config.session.defaultTtlSeconds
})

if (!result.ok) {
  return reply.status(401).send(result.error.publicError)
}

// No tokenHash here.
const token = result.value.token
```

## Method validation context

```ts
const validated = method.operations.authenticate.validate(input, {
  method: { methodId: 'password.email', methodKind: 'password' },
  auth: context,
  now: clock.now(),
})
```

The `lookup` returned by validation is passed back to `method.run()` and must match the returned proof.

## OTP begin / complete

```ts
const begin = await auth.begin({
  context,
  methodId: 'otp.email',
  input: { subject: 'ada@example.com' },
  account: { mode: 'require-existing-identity' },
  session: {},
})

if (!begin.ok) return reply.status(400).send(begin.error.publicError)

// Normally run by a separate worker process after the auth transaction commits.
const delivery = await outboxWorker.runOnce({ now: clock.now() })
if (!delivery.ok) throw new Error('Outbox delivery failed')

const complete = await auth.complete({
  context,
  challengeId: begin.value.challengeId,
  input: { code: secretFactory.raw('123456') },
})
```

`begin()` commits the challenge and required delivery request in one transaction. `complete()` has no `methodId`; core loads the challenge and uses the stored method.

## Bearer carrier mutation

```ts
const mutation = {
  type: 'set-header',
  name: 'authorization',
  value: { parts: ['Bearer ', rawToken] },
} as const
```

The framework adapter reveals secret parts only at the final HTTP write.

## Delivery side effect

```ts
const sideEffect = {
  type: 'delivery',
  dispatchPolicy: 'required',
  idempotencyKey: 'otp:challenge_123',
  message: {
    to: { channel: 'email', target: 'ada@example.com' },
    templateId: 'auth.otp.email',
    data: {
      code: rawOtp,
      expiresInMinutes: 5,
    },
  },
} as const
```

Methods return template/data messages. Delivery transports receive `DeliveryContext` and render subject/text/html at the final transport boundary.


## Optional token session lookup

`getSession()` accepts an absent token and treats it as anonymous/no active session:

```ts
const read = carrier.read(requestView)
const session = await auth.getSession({
  context,
  token: read.ok && read.value.found ? read.value.token : undefined,
})

if (session.ok && session.value === null) {
  // anonymous request or invalid/expired/revoked token
}
```
