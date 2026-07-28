# Authoring guide

This document explains how to add new modules without changing core.

## New auth method

1. Pick a stable `methodKind`, such as `oauth`, `passkey` or `api-key`.
2. Pick a configured `methodId` namespace, such as `oauth.google` or `passkey.default`.
3. Implement only supported operations: `enroll`, `authenticate`, `begin`, `complete`.
4. `validate(input, context)` parses unknown input and returns canonical `lookup` when the subject is known before `run()`.
5. Normalize subjects deterministically. Changing normalization requires migration or a new methodId.
6. Return method-owned material through `CredentialMaterial` or `ChallengeMaterial`; credential updates are full replacements, not partial patches.
7. For enroll, return `MethodEnrollResult.identity` as an `IdentityClaim`. If a lookup was produced, the enroll identity must match it exactly.
8. Return `AuthProof` only after actual proof. If a lookup was produced, proof identity must match it exactly.
9. Do not create accounts, sessions, cookies, store records or framework responses.
10. Never persist or log `RawSecretValue`.
11. Add method compliance tests.

## New store adapter

1. Implement only store contracts.
2. Filter every query by `tenantId`.
3. Enforce `unique(tenantId, methodId, subject)` for identities.
4. Keep store versions internal.
5. Implement challenge consume atomically.
6. Never accept or persist `RawSecretValue`.
7. Use `TransactionContext` from `transaction.d.ts` if the adapter claims transaction support.

## New token format

1. Implement `TokenFormat`.
2. `issue()` returns `TokenIssueResult` with raw token and token hash only; core supplies issuedAt/expiresAt to `IssuedTokenView` from `TokenIssueInput`.
3. Core must store token hash and expose only `IssuedTokenView`.
4. `identify()` receives `expectedTenantId` and returns `null` for normal no-usable-token cases, including malformed, invalid, expired or tenant-mismatched token material. Use `Result.ok=false` only for infrastructure/crypto/internal token-format failures.
5. Do not know cookies, headers or framework responses.

## New carrier

1. Implement `HttpTokenCarrier`.
2. Read token from normalized request view.
3. Return HTTP mutations, not framework responses.
4. Keep `RawSecretValue` wrapped until final framework write.
5. For headers, use parts-based `SecretHttpValue`.
6. For cookies, use `RawSecretValue<string>` as cookie value and safe defaults.

## New delivery transport

1. Implement `DeliveryTransport`.
2. Use `DeliveryContext` for tenant-aware sender/template routing; do not require full `AuthContext` in delivery transports.
3. Own template rendering.
4. Never log rendered secrets.
5. Treat `RawSecretValue` specially and reveal only during final send.
6. Do not know OTP/account/session semantics.

## New effects dispatcher

1. Implement `SideEffectDispatcher`.
2. Decide sync/no-op/outbox behavior outside core.
3. Honor `dispatchPolicy`: required failures return `ok: false`; best-effort failures return `ok: true` with `failed[]`.
4. If durable persistence is used, seal raw secrets before persistence.
5. Outbox dispatchers use the narrow `OutboxEnqueueStore`; workers use `OutboxWorkerStore`. Core must not know leases or worker details.

## ID generation

Use generic ID kinds instead of adding new methods to `IdGenerator`:

```ts
idGenerator.generate({ kind: 'account' })
idGenerator.generate({ kind: 'outbox-message' })
idGenerator.generate({ kind: 'api-key.credential' })
```

## Future credential-first lookup

The baseline uses identity-first `IdentityLookup`. Future methods such as passkeys/API keys may need credential-first lookup. Do not fake those through subjects; add a clear extension contract when implementing those methods.

## Preset packages

Preset packages may compose modules for convenience:

```text
@authmodules/preset-express-postgres
@authmodules/preset-express-postgres-redis
```

Rules:

```text
Presets may wire packages.
Presets must not own new auth behavior.
Presets must not bypass compliance.
Presets must not weaken security defaults.
```


## 0.1.0 authoring rules

- Methods should set `countsAsAttempt: true` only for verification failures that should consume a challenge or guard attempt, such as a wrong password or OTP. Infrastructure and validation failures must leave it false.
- Methods must set `proof.proofMethod` to the executing `methodId/methodKind`; core rejects mismatches.
- Store adapters must implement explicit lifecycle mutations: `IdentityStore.markVerified()` and `CredentialStore.updateStatus()`.
- Effects implementations receive `SideEffectContext`; do not depend on actor, IP, user agent or policy input unless a future extension explicitly adds that data.
- Validation messages are public-safe and must never echo raw user input or secrets.
