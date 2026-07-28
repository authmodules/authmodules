# 00 — Model

## Purpose

AuthModules is a standard for modular authentication. This archive is a specification, not an implementation.

The goal is a small core with replaceable modules:

```text
core + auth methods + store + token format + HTTP carrier + effects + framework adapters + app wiring
```

For visual diagrams and sequence flows, see `docs/07-DIAGRAMS.md`.

## Responsibility table

| Role | Owns | Must not own |
|---|---|---|
| App / composition root | wiring, secrets, templates, deployment config | auth internals |
| Core | orchestration, account/identity/credential/session lifecycle, policy gates, public error mapping, core record IDs | HTTP carrier, concrete stores, delivery/outbox mode, password hashing algorithms |
| Auth method | validation, subject normalization, proof, enrollment material, challenge material | accounts, sessions, final linking, framework responses |
| Store | durable/session/ephemeral records and concurrency | auth decisions |
| Token format | raw token creation, token identity, token hash/verifier material | cookies, HTTP headers, session storage |
| HTTP carrier | cookie/header representation as HTTP mutations | token verification, sessions, accounts |
| Side effect dispatcher | Baseline delivery dispatch via a narrow `SideEffectContext`; extension dispatchers may own outbox/webhook/push dispatch | auth decisions, proof verification, full `AuthContext` |
| Delivery transport | sending template/data messages | OTP semantics, accounts, sessions |
| Framework adapter | request/response adaptation | store access, proof verification |
| Testkit | deterministic doubles and compliance suites | production behavior |

## Method identity model

`methodKind` and `methodId` are different:

```text
methodKind = mechanism type, such as password, otp, oauth
methodId   = configured identity namespace, such as password.email, otp.email, oauth.google
```

Identity uniqueness is:

```text
unique(tenantId, methodId, subject)
```

Methods own subject normalization:

```text
lookup.subject is canonical.
display is non-canonical UI data.
Changing normalization requires data migration or a new methodId namespace.
```

## Core API

Core exposes generic operations only:

| Operation | Meaning |
|---|---|
| `enroll` | create/link identity and optional credential material |
| `authenticate` | single-step proof flow |
| `begin` | start challenge/redirect/link flow |
| `complete` | complete challenge/callback/link flow |
| `getSession` | identify current session |
| `revokeSession` | revoke a session |

Password/OTP convenience helpers may exist outside core, but are not part of the base `Auth` interface.

## Store model

The aggregate is called `AuthStore`:

```text
durable   — accounts, identities, credentials
session   — session records
ephemeral — challenges, optional unless challenge methods are configured
```

Outbox is not a core store slot. It belongs to the optional effects-outbox extension.

## Public views vs store records

Store records may contain sensitive/internal fields such as `tokenHash`, challenge material and optimistic versions.

Core public APIs return only:

```text
AccountView
IdentityView
CredentialView
SessionView
IssuedTokenView
```

Core must not return store records or `TokenIssueResult`.

## Secret model

Secrets are typed:

```text
RawSecretValue     — in-memory only, never persisted
ProtectedValue     — hash/verifier material, may be persisted but serializes redacted
SealedSecretValue  — encrypted/sealed payload, may be persisted under strict rules
```

`SecretFactory` wraps framework input and store DTOs into safe runtime values. Crypto hashing/HMAC accepts `RawSecretValue`, so methods do not need to reveal secrets just to protect them.

## Session TTL model

Session expiry has one source of truth:

```text
CreateAuthConfig.session.defaultTtlSeconds
```

Per-request `session.ttlSeconds` may override it only up to `maxTtlSeconds` when configured. A missing `session` field means no session creation. Core computes `expiresAt` before calling `token.issue()`.

## Composition example

Core consumes the auth-store and effect-dispatcher contracts. The application composition root wires their shared transaction boundary:

```ts
const stores = createPostgresAuthOutboxStores({ client })

const authResult = createAuth({
  store: stores.auth,
  methods: {
    'password.email': createPasswordMethod({ methodId: 'password.email', passwordHasher }),
    'otp.email': createOtpMethod({ methodId: 'otp.email', crypto, verificationKey, ttlSeconds: 300 }),
  },
  token: createOpaqueTokenFormat({ crypto }),
  session: { defaultTtlSeconds: 60 * 60 * 24 * 7, maxTtlSeconds: 60 * 60 * 24 * 30 },
  effects: createOutboxEffectsDispatcher({
    store: stores.outbox,
    sealer: outboxSealer,
    idGenerator: createOutboxMessageId,
  }),
  policy,
  eventSink,
  clock,
  idGenerator,
})

if (!authResult.ok) throw new Error('Invalid AuthModules configuration')
const auth = authResult.value
```

Required OTP delivery is queued in the same transaction as challenge and account state. A separately composed outbox worker performs the external transport call after commit. Synchronous delivery is only suitable when the operation does not mutate auth state.

Framework composition owns the carrier:

```ts
const expressAuth = createExpressAuthAdapter({
  auth,
  carrier: createCookieTokenCarrier({ name: '__Host-am_session' }),
  tenantResolver: resolveTenantFromTrustedRoute,
})
```

## 0.1.0 invariants

```text
session.defaultTtlSeconds is the default expiry source for session creation.
idGenerator.generate({ kind }) is the only core ID creation API.
method.validate(input, context) owns canonical lookup.
method.run(..., context.lookup) receives the same canonical lookup without duplicate tenant fields.
If enroll/proof returns identity data for a known lookup, core must verify identity binding before writing records.
ChallengeBinding.startedByActor records the begin actor, but complete must re-check current authorization.
Stable root exports are baseline focused; guard is stable optional; outbox lives behind extension exports.
SideEffectDispatcher receives SideEffectContext, not full AuthContext.
SideEffectContext and DeliveryContext are role aliases of one shared DispatchContext shape.
getSession accepts a missing token and treats it as no active session.
Challenge failed-attempt counters advance only when MethodFailure.countsAsAttempt === true.
```


## Identity vocabulary

| Term | Meaning |
|---|---|
| `IdentityLookup` | canonical subject known before proof or stored on a challenge |
| `IdentityClaim` | method claim about an identity after enroll/proof |
| `IdentityRecord` | persisted identity in a store |
| `IdentityView` | safe public identity returned by core |


## Visual explanation

See `docs/07-DIAGRAMS.md` for Mermaid diagrams and compact tables covering package boundaries, core flows, token/session split, challenge lifecycle and side-effect dispatch.
