# ADR-0004: Token format vs HTTP carrier

## Status

Accepted

## Decision drivers

- Token material and HTTP transport are different responsibilities.
- Cookie, bearer and framework-specific response APIs should not leak into token formats.
- Raw session tokens must remain secret-wrapped until the final response write.

## Options considered

### Option A — Token package writes cookies directly

Pros:
- simple for cookie-only apps.

Cons:
- couples token format to HTTP;
- harder to support bearer/native clients;
- risks leaking raw token strings early.

### Option B — Token format + HTTP carrier

Pros:
- token format owns issue/identify/hash;
- carrier owns cookie/header representation;
- framework adapter owns final mutation application.

Cons:
- one extra adapter boundary.

## Decision

Separate token formats from HTTP carriers.

```text
@authmodules/token-opaque   -> TokenFormat
@authmodules/carrier-cookie -> HttpTokenCarrier
```

Carrier mutations may contain `RawSecretValue` until the framework adapter writes the final response.

## Consequences

Positive:
- easier JWT/opaque/bearer/cookie combinations;
- safer token handling;
- framework adapters remain thin.

Negative:
- direct cookie writes require a carrier + framework adapter.

## Revisit when

- non-HTTP transports become first-class;
- framework adapters need a richer mutation model.
