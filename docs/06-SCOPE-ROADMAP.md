# 06 — Scope and roadmap

## Baseline normative target

The baseline proves the standard without requiring Redis or distributed workers in every deployment.

```text
@authmodules/contracts
@authmodules/core
@authmodules/testkit
@authmodules/method-password
@authmodules/method-otp
@authmodules/store-postgres
@authmodules/crypto-node
@authmodules/token-opaque
@authmodules/carrier-cookie
@authmodules/delivery-email-smtp
@authmodules/effects-outbox
@authmodules/outbox-worker
@authmodules/framework-express
```

The baseline supports:

```text
password enroll/sign-up
password authenticate/sign-in
OTP begin/complete
opaque sessions
cookie carrier
Postgres account/identity/credential/session/challenge/outbox stores
transactional outbox email delivery
Express adapter
compliance tests
```

`ChallengeStore` may be omitted only by apps that configure no challenge methods. The baseline reference stack includes it because OTP uses `begin`/`complete`. OTP also emits required delivery while writing challenge state, so its reference composition uses the transactional outbox and worker.

## Optional adapters and hardening

The following packages are implemented and covered by executable compliance cases but are not required by every composition:

```text
@authmodules/guard-memory
@authmodules/effects-sync-delivery
```

Adds:

```text
bounded single-process rate limit / lockout guard
synchronous delivery for operations that do not mutate auth state
```

Production profile must not change core APIs or weaken baseline behavior.

## Roadmap examples

Future modules should extend through existing roles, not by expanding core:

```text
@authmodules/method-oauth
@authmodules/method-oidc
@authmodules/method-passkey
@authmodules/method-magic-link
@authmodules/token-jwt
@authmodules/carrier-bearer
@authmodules/store-redis
@authmodules/framework-hono
@authmodules/framework-next
@authmodules/delivery-sms-twilio
@authmodules/preset-express-postgres
```

## What must not enter baseline core

```text
refresh tokens
OAuth/passkey/SAML implementations
policy ecosystem package
distributed transactions
required audit sink
framework-specific response logic
provider-specific delivery rendering
```


## 0.1.0 scope note

The core baseline remains normative. Guard is a stable optional hardening hook. Outbox contracts are exported separately from the stable root contract barrel and are optional for applications without required state-mutating delivery; the OTP reference profile includes them. The memory guard is single-process only; distributed guards and stores remain future adapters.
