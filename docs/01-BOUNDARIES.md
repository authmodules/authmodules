# 01 — Boundaries

## Package families

### Normative contracts

```text
@authmodules/contracts
```

Stable baseline subpath exports:

```text
/result
/primitives
/transaction
/security
/errors
/crypto
/material
/method
/views
/core
/store
/token
/carrier
/delivery
/effects
/observability
/guard              # stable optional hardening hook
```

Optional extension exports live behind `@authmodules/contracts/extensions` or explicit subpaths:

```text
/outbox
```

### Core

```text
@authmodules/core
```

May import only `@authmodules/contracts/*` and explicit optional extension types.

Must not import concrete packages:

```text
method-* store-* token-* carrier-* delivery-* effects-* framework-* outbox-worker-*
```

Core returns public views and public token views. It never returns store records or `TokenIssueResult`. Core requires `SessionConfig.defaultTtlSeconds` when sessions are enabled.

### Auth methods

```text
@authmodules/method-password
@authmodules/method-otp
```

Methods may import contracts and receive crypto/hashers/sealers through config.

Methods own:

```text
validation
subject normalization
proof/enrollment/challenge material
method-specific verifier logic
```

Methods must not own:

```text
accounts
sessions
final linking
framework responses
outbox records
```

### Stores

```text
@authmodules/store-postgres
@authmodules/store-redis
```

Stores implement record persistence and concurrency semantics. They do not decide auth outcomes.

Store contract depends on `material` and `transaction`, not on `method`. Outbox storage is an extension contract used by effects-outbox, not a required core store slot.

### Crypto

```text
@authmodules/crypto-node
```

Crypto returns secret randomness as `RawSecretValue`:

```text
randomSecretBytes()
randomSecretString()
```

`randomPublicBytes()` is only for non-secret randomness. `hash()` and `hmac()` accept `RawSecretValue` directly. HMAC generation requires the length-prefixed `hmac-sha256.v2` framing; legacy framing is verification-only and must never be selected as a fallback after a v2 mismatch.

### Token formats

```text
@authmodules/token-opaque
@authmodules/token-jwt      # roadmap
```

Token formats return `TokenIssueResult` with raw token and token hash only. Core stores `tokenHash`, supplies issued/expires timestamps from `TokenIssueInput`, and returns only `IssuedTokenView` outward.

Token formats must not know cookies, HTTP responses or session stores.

### HTTP carriers

```text
@authmodules/carrier-cookie
@authmodules/carrier-bearer # roadmap
```

Carriers read/write token material through framework-neutral HTTP mutations. They preserve `RawSecretValue` until the final framework response write.

Header values use parts-based `SecretHttpValue`, so Bearer values can be represented as:

```ts
{ parts: ['Bearer ', rawToken] }
```

Cookie token values are always `RawSecretValue<string>`.

### Delivery

```text
@authmodules/delivery-email-smtp
```

Delivery is template/data-first. Core-side delivery messages must not contain rendered `text/html` with interpolated secrets. `DeliveryTransport.send()` receives safe `DeliveryContext`, not full `AuthContext`, for tenant-aware routing/templates. `SideEffectDispatcher` receives safe `SideEffectContext`, not full `AuthContext`.

### Effects

```text
@authmodules/effects-sync-delivery
@authmodules/effects-outbox       # reference OTP production profile
@authmodules/effects-noop         # tests/dev
```

Core only knows `SideEffectDispatcher`. Sync delivery, outbox persistence, sealing and retries are dispatcher implementation details.

### Outbox

```text
@authmodules/outbox-worker # reference OTP production profile
```

Outbox worker dispatches durable `OutboxMessage` records with leases. It does not decide auth outcomes and is not exported from the stable root contract surface.

### Guard

```text
@authmodules/guard-* # optional production hardening
```

`AuthGuard` is a stable optional hook for rate limits, lockouts and attempt tracking. The baseline does not require a guard implementation, but the hook is stable because core can provide the safest attempt context and outcome reasons.

### Frameworks

```text
@authmodules/framework-express
```

Framework packages adapt HTTP request/response models. They import contracts only and receive the core API as an injected contract implementation. They must not import concrete core, store or method implementations.

## Import rule

```text
app -> everything it composes
core -> contracts only
implementations -> contracts only
framework-* -> contracts only
contracts -> no implementation packages
```

## Naming rule

Use these names consistently:

```text
method-*              auth proof/enrollment methods
store-*               persistence adapters
token-*               token formats
carrier-*             HTTP token carriers
delivery-email-*      email delivery transports
effects-*             side-effect dispatchers
framework-*           HTTP framework adapters
outbox-worker         durable delivery worker
```

Do not use legacy names:

```text
provider-*            too ambiguous
token-cookie          mixes token format and carrier
state-*               less clear than store-*
delivery-smtp         ambiguous; SMTP is email transport
```

## Stable vs extension contracts

| Contract | Stability | Baseline? |
|---|---|---:|
| `result` | stable | yes |
| `primitives` | stable | yes |
| `transaction` | stable | yes |
| `security` | stable | yes |
| `errors` | stable | yes |
| `crypto` | stable | yes |
| `material` | stable | yes |
| `method` | stable | yes |
| `views` | stable | yes |
| `core` | stable | yes |
| `store` | stable | yes |
| `token` | stable | yes |
| `carrier` | stable | yes |
| `delivery` | stable | yes |
| `effects` | stable minimal port | yes |
| `observability` | stable best-effort | yes |
| `guard` | stable optional hook | no |
| `extensions/outbox` | extension | no |

## ID boundary

Core `IdGenerator` is generic. Stable core uses these kinds:

```text
account
identity
credential
session
challenge
```

Extensions must use their own namespaced kinds, for example `outbox-message`, without adding methods to the core ID generator.


## Boundary diagrams

See `docs/07-DIAGRAMS.md` for Mermaid diagrams of package dependencies, runtime collaborations and extension boundaries.
