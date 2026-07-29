# Changelog

## 0.1.1 — Validation hardening

- Hardened mutation timestamp validation in the in-memory test store.
- Hardened PostgreSQL record validation for hostile date values.
- Mapped invalid opaque token dates and hostile guard inputs to typed failures.
- Validated renewed outbox leases before worker reuse.

## 0.1.0 — First release

- Established framework-neutral authentication and identity contracts.
- Added policy-driven core enrollment, authentication, challenge, and session flows.
- Added password and destination-bound OTP methods.
- Added PostgreSQL, Node.js crypto, opaque token, cookie, Express, SMTP, guard, and outbox adapters.
- Added executable compliance suites, real PostgreSQL integration coverage, cross-package authentication stack tests, and packed-consumer verification.

Published as protected `v0.1.0` releases through GitHub Packages. npmjs publication remains intentionally deferred.
