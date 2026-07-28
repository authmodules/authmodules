# 04 — Security and errors

## Secret categories

| Type | Lifetime | May persist? | May log? | Examples |
|---|---|---:|---:|---|
| `RawSecretValue` | in-memory only | no | no | raw password, OTP, session token |
| `ProtectedValue` | persisted verifier/hash | yes | redacted only | password hash, token hash, OTP verifier |
| `SealedSecretValue` | encrypted/sealed payload | yes, with purpose/expiry | redacted only | sealed outbox OTP payload |

Rules:

```text
RawSecretValue must never be persisted, logged, audited or emitted as event attributes.
ProtectedValue and SealedSecretValue serialize redacted by default.
PublicData must not contain RawSecretValue, ProtectedValue or SealedSecretValue.
PrivateData may contain ProtectedValue or SealedSecretValue, never RawSecretValue.
DeliveryData may contain RawSecretValue only while dispatching in memory.
PersistableDeliveryData may contain only JsonValue and SealedSecretValue.
```

## Crypto rules

```text
randomSecretBytes/randomSecretString return RawSecretValue.
randomPublicBytes is only for non-secret randomness.
hash/hmac accept RawSecretValue directly.
Methods should not call reveal() just to hash/HMAC/protect a secret.
HMAC generation uses explicit `hmac-sha256.v2` framing. Legacy values are verified only through a scheme-selected migration branch that cannot generate new legacy material or fall back after a v2 mismatch.
```

## Token rules

```text
TokenIssueResult is internal to core and contains only raw + tokenHash.
Core owns issuedAt/expiresAt and builds IssuedTokenView.
IssuedTokenView is public and contains no tokenHash.
SessionRecord stores tokenHash as ProtectedValue.
TokenIdentifyInput includes expectedTenantId.
TokenFormat.identify() returns `null` for normal no-usable-token cases: malformed, invalid, expired or tenant-mismatched token material.
Tenant mismatch maps to null from getSession() and SESSION_INVALID only at framework/require-session boundaries.
```

## Runtime boundary rules

```text
Core snapshots caller control data and validated method output before asynchronous collaborators run.
Method, guard, policy and effects adapters receive isolated context and time values.
Store records must match the requested tenant and stable key; mismatched or malformed records fail closed.
Malformed or throwing token/store collaborators are availability failures, not authentication evidence.
```

## Carrier rules

```text
Cookie token values are RawSecretValue<string>.
Header values are parts-based SecretHttpValue.
Bearer header example: { parts: ['Bearer ', rawToken] }.
Framework adapters reveal secrets only at final response write.
```

## Delivery rules

```text
DeliveryMessage is template/data-first.
Core/methods must not render subject/text/html with interpolated secrets.
Delivery transport owns rendering and receives safe DeliveryContext, not full AuthContext. Side-effect dispatchers receive safe SideEffectContext, not full AuthContext.
Delivery locale precedence is DeliveryMessage.locale ?? DeliveryContext.locale.
Delivery logs serialize secret values redacted.
```

## Identity binding security rule

If a method returned a canonical lookup during validation, or a challenge record contains a lookup from `begin`, core must verify that the identity/proof data returned by the method matches that lookup. This prevents an implementation from loading credential/challenge state for one subject but accepting proof for another subject.

Mismatch is `IDENTITY_BINDING_MISMATCH`.

## Public vs internal errors

Public errors are intentionally small. Internal reasons are richer and are for audit, events and debugging.

| Internal reason | Public code | Notes |
|---|---|---|
| `VALIDATION_FAILED` | `INVALID_INPUT` | details must be safe |
| `CREDENTIAL_NOT_FOUND` | `AUTHENTICATION_FAILED` | prevents login enumeration |
| `IDENTITY_NOT_FOUND` during login | `AUTHENTICATION_FAILED` | prevents account enumeration |
| `PASSWORD_MISMATCH` | `AUTHENTICATION_FAILED` | same as missing credential |
| `PASSWORD_POLICY_FAILED` | `INVALID_INPUT` | safe password policy message allowed |
| `IDENTITY_BINDING_MISMATCH` | `AUTHENTICATION_FAILED` or `CHALLENGE_FAILED` | method identity/proof did not match validated/stored lookup; log internally as security issue |
| `ACCOUNT_DISABLED` before proof | `AUTHENTICATION_FAILED` | safer default |
| `ACCOUNT_DISABLED` after proof | `ACCOUNT_UNAVAILABLE` | acceptable after successful proof |
| `IDENTITY_CONFLICT` | `CONFLICT` | signup/linking conflict |
| `ACCOUNT_LINKING_DENIED` | `AUTHORIZATION_FAILED` | policy denied link |
| `SESSION_TTL_INVALID` | `INVALID_INPUT` | requested session TTL exceeds configured max |
| `TOKEN_INVALID` | `SESSION_INVALID` | framework/require-session boundary only |
| `TOKEN_EXPIRED` | `SESSION_INVALID` | framework/require-session boundary only |
| `TOKEN_TENANT_MISMATCH` | `SESSION_INVALID` | framework/require-session boundary only |
| `SESSION_NOT_FOUND` | `SESSION_INVALID` | framework/require-session boundary only |
| `SESSION_EXPIRED` | `SESSION_INVALID` | framework/require-session boundary only |
| `SESSION_REVOKED` | `SESSION_INVALID` | framework/require-session boundary only |
| `CHALLENGE_NOT_FOUND` | `CHALLENGE_FAILED` | do not disclose challenge existence |
| `CHALLENGE_EXPIRED` | `CHALLENGE_FAILED` | safe generic challenge failure |
| `CHALLENGE_ALREADY_CONSUMED` | `CHALLENGE_FAILED` | prevents replay details |
| `OTP_MISMATCH` | `CHALLENGE_FAILED` | counts as attempt |
| `RATE_LIMITED` | `RATE_LIMITED` | may include retryAfterSeconds |
| `LOCKED` | `RATE_LIMITED` | or `TEMPORARILY_UNAVAILABLE` |
| `STORE_UNAVAILABLE` | `TEMPORARILY_UNAVAILABLE` | infrastructure failure |
| `TRANSACTION_FAILED` | `TEMPORARILY_UNAVAILABLE` | transaction boundary failed or rolled back |
| `DELIVERY_FAILED` required effect | `TEMPORARILY_UNAVAILABLE` | OTP delivery unavailable |
| `SIDE_EFFECT_FAILED` required effect | `TEMPORARILY_UNAVAILABLE` | no dispatcher configured or dispatcher failed to accept/perform required effect |
| `EVENT_SINK_FAILED` | not normally public | event sinks are best-effort and must not fail baseline auth operations |

Password authentication does not return early for an unknown identity or missing credential. Core invokes the method without credential material, and the password method performs dummy hash work before returning the same public failure. This reduces account-enumeration timing differences; hosts must still apply rate limiting and avoid treating timing as a formal constant-time guarantee across external stores and hash upgrades.
| `CRYPTO_FAILED` | `INTERNAL` | do not expose crypto details |
| `INTERNAL` | `INTERNAL` | generic fallback |

Framework adapters expose only `PublicAuthError` by default. `AuthFailure.internalReason` must not be returned to clients unless the application explicitly opts into a trusted debug mode.

## `getSession()` error model

`getSession()` returns `ok: true, value: null` for “no active session” cases: missing token, `TokenFormat.identify()` returning `null`, token hash not found, expired session or revoked session. Missing token is not an internal error reason in core. It returns `ok: false` only for infrastructure/internal failures such as store unavailability or unexpected token/crypto failure.

Framework helpers such as `requireSession()` may convert `null` to public `SESSION_INVALID`.

## Result and throw boundaries

Contracts model expected failures with `Result<T, E>`. Collaborators should not throw for expected validation/auth/store/token/delivery failures.

Core must still catch thrown exceptions from collaborators and map them to safe failures:

| Throw source | Mapping rule |
|---|---|
| method throws | method component failure -> safe `AuthFailure` |
| store throws | `STORE_UNAVAILABLE` or `INTERNAL` |
| token throws | token component failure -> safe `AuthFailure` |
| delivery/effects throws | `SIDE_EFFECT_FAILED` / `DELIVERY_FAILED` depending boundary |
| policy throws | fail closed as `POLICY_DENIED` or safe `INTERNAL` |
| guard throws | fail closed as `RATE_LIMITED`, `TEMPORARILY_UNAVAILABLE` or safe `INTERNAL` |
| event sink throws | must not fail baseline auth result; diagnostic only |

Original thrown errors, stack traces, SQL messages, SMTP responses, request bodies and raw provider errors must not be copied into normative DTOs.

## Public error message safety

`PublicAuthError.message` is optional and must be generic, safe and localizable. It must not contain:

```text
internalReason
stack traces
SQL/SMTP/provider error text
raw token, OTP, password or verifier material
account existence hints
challenge existence hints
```

Applications may provide localized public messages at framework/UI boundaries using `PublicAuthError.code`.

## Validation message safety

`ValidationIssue.message` is optional and must be public-safe. It must not echo raw input, passwords, OTPs, tokens, provider error text, account existence hints or challenge existence hints. Prefer stable validation codes and localized UI messages over method-generated text.

## Event sink

`AuthEventSink` is best-effort observability only in baseline. Required audit must be modeled as durable side effect/outbox behavior, not as event sink failure semantics.

## Failure payload safety

Failure shapes must not carry `cause?: unknown` in the normative contract. Implementations may keep original errors internally, but public/component failure DTOs must contain only redacted, safe `PublicData` details.

## Shallow secret-bearing data

`PrivateData`, `DeliveryData` and `PersistableDeliveryData` are shallow extension objects by contract. Flatten nested secret-bearing template data before passing it to AuthModules.

## Side-effect context privacy

`SideEffectDispatcher` receives `SideEffectContext`, not full `AuthContext`. Effects and delivery transports should receive only tenant/request/locale/safe metadata needed for dispatch. Actor, IP, user agent and policy-only inputs must not be forwarded unless a future extension explicitly requires them.

## Shared dispatch context

`DispatchContext` is the only stable baseline context shape forwarded to side-effect and delivery boundaries. It contains `tenantId`, optional `requestId`, optional `locale` and safe metadata only. Core must not forward actor, IP, user agent or policy-only inputs to `SideEffectDispatcher`/`DeliveryTransport` unless a future extension explicitly defines such a boundary.
