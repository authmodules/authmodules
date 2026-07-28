# 05 — Compliance

Compliance suites are executable proof that implementations obey the contract. They are more important than prose once code exists.

## Baseline compliance

### Boundary checks

- core imports stable contracts only, plus optional extension types only when explicitly configured;
- method/store/token/carrier/delivery/effects packages do not import core;
- framework adapter imports core public API and carrier contract only;
- carrier is not accepted by `createAuth()`;
- stable root exports may include guard as optional, but must not make outbox look required.

### Core checks

- `createAuth()` validates config and returns `Result<Auth, ConfigValidationFailure>`;
- method registry key equals `method.methodId`;
- `session.defaultTtlSeconds` is positive;
- request TTL uses presence-based session rules and default/max TTL rules;
- challenge store is required only if any method has `begin` or `complete`;
- core uses `idGenerator.generate({ kind })`, not per-record ID methods;
- core public results contain views, not store records;
- core public token is `IssuedTokenView`, not `TokenIssueResult`;
- policy/guard attempt lifecycle follows `docs/02-FLOWS.md`;
- policy/guard attempt checks include `MethodRef` with both methodId and methodKind;
- `begin()` performs account preflight when lookup is known before challenge delivery;
- `complete()` prechecks tenant/status/expiry/attempts before method verification;
- challenge failed attempt increments happen only when `MethodFailure.countsAsAttempt === true`;
- guard failure budgets use `GuardAfterAttemptInput.outcome.countsAsAttempt` instead of classifying reason strings;
- `complete()` chooses method from `ChallengeRecord.methodId`;
- `complete()` uses stored `ChallengeBinding`, not caller-supplied account/session intent;
- required side effects without a dispatcher fail with `SIDE_EFFECT_FAILED` before auth-state persistence;
- method enroll identity and proof must match canonical lookup when lookup exists;
- policy uses the single `CorePolicy` hook;
- `PolicyCheck.create-session` includes requested/resolved TTL and `expiresAt`;
- `getSession()` accepts optional token and returns `ok: true, value: null` for missing/invalid/expired/revoked/no active session and reserves `ok: false` for infrastructure/internal failures;
- `revokeSession()` is idempotent and non-enumerating for logout-style revocation;
- core catches thrown collaborator exceptions and maps them to safe failures.

### Method checks

- validators receive `MethodValidationContext`;
- validators return canonical subject lookup when known;
- subject normalization is deterministic;
- `MethodExecutionContext.lookup` equals the validation/challenge lookup;
- methods do not create accounts/sessions;
- method begin does not return `challengeId`;
- method begin returns required positive `maxAttempts` and stores verifier/material only through `ChallengeMaterial`;
- method output validation follows the table in `docs/02-FLOWS.md`, including `proofMethod`, proof expiry and identity binding checks;
- method complete validation lookup must match stored challenge lookup when both exist;
- authenticate methods cannot mutate store versions directly; credential material changes are full `CredentialMaterial` replacements;
- password mismatch is a normal verification result, not crypto failure.

### Store checks

- every query filters by `tenantId`;
- identity uniqueness is `unique(tenantId, methodId, subject)`;
- credential material replacement is full replacement and requires core-supplied expected version;
- material `schemaVersion` is not confused with store optimistic `version`;
- `IdentityStore.markVerified()` updates identity verification timestamp;
- `CredentialStore.updateStatus()` changes credential status with expected version;
- `CredentialStore.updateStatus()` and `IdentityStore.markVerified()` preserve tenant filtering and version/consistency rules;
- challenge consume is atomic and version-aware;
- `recordFailedAttempt()` returns explicit control results for recorded/attempts-exceeded/expired/version-conflict;
- no `RawSecretValue` persistence;
- optional challenge store is validated when challenge methods are configured;
- transaction context comes from `transaction.d.ts`, not from store-specific types;
- transaction runners receive `requiredScopes` before callback execution and reject unsupported scopes without invoking it;
- each store operation rejects foreign, expired, or out-of-scope transaction contexts;
- multi-scope method writes fail before persistence when the runner is missing, malformed, throws, or does not cover every required scope.

### Token/carrier checks

- token issue returns raw token + tokenHash internally, without duplicating issuedAt/expiresAt;
- core stores tokenHash and returns raw token view only;
- token identify receives expected tenant and `TokenFormat.identify()` returns null for normal no-usable-token cases;
- header carrier uses parts-based `SecretHttpValue`;
- cookie carrier value is `RawSecretValue<string>`;
- framework reveals secrets only at final response write.

### Delivery/effects checks

- `DeliveryMessage` is template/data-first;
- `SideEffectDispatcher` receives `SideEffectContext`, not full `AuthContext`;
- `DeliveryTransport.send()` receives `DeliveryContext`, not full `AuthContext`;
- delivery locale precedence is `DeliveryMessage.locale ?? DeliveryContext.locale`;
- method/core do not render secret-bearing text/html;
- required effect failure returns `Result.ok=false`;
- required effects have stable idempotency keys;
- required synchronous effects cannot accompany auth-state writes;
- transactional dispatchers declare their storage through `transactionScopes`;
- best-effort effect failure returns `Result.ok=true` with `SideEffectDispatchResult.failed[]`;
- durable/outbox dispatch never persists `RawSecretValue`;
- secret values are redacted in logs/events/errors;
- normative failures do not expose `cause?: unknown`;
- thrown collaborator exceptions are caught and mapped to safe failures;
- public error messages are generic and leak-free;
- delivery/effects duplicate metadata fields are not used.

## Account resolution compliance

Implement the matrix from `docs/02-FLOWS.md` exactly. In particular:

- login-like missing identity must not reveal whether account exists;
- signup identity conflict maps to `CONFLICT`;
- linking to another account through `link-to-actor-account` must fail unless it is the same current actor account;
- `link-to-actor-account` requires an account actor;
- `ChallengeBinding.startedByActor` is not enough for authorization at complete time.

## Error mapping compliance

Implement the mapping table from `docs/04-SECURITY-ERRORS.md`. Public error codes must be stable and leak-safe.

## Status transition compliance

Implement the transition tables from `docs/02-FLOWS.md` for account, credential, session and challenge records. Invalid transitions must fail predictably.

## Result boundary compliance

- expected failures are returned as `Result.ok=false`, not thrown;
- core catches thrown collaborator exceptions and maps them to safe failures;
- public error messages are generic/localizable and never include internal reasons, stack traces, provider errors or existence hints;
- `ValidationIssue.message` is public-safe and never echoes raw input;
- original thrown causes are not copied into normative failure DTOs.

## Optional reliability profile compliance

The executable catalog includes the implemented guard/outbox profile. Its normative checks are:

- `AuthGuard` rate-limit/lockout behavior;
- effects-outbox dispatcher;
- atomic ordered `OutboxStore.enqueueBatch`;
- `OutboxStore` lease-aware `claimBatch`;
- lease renewal before unsealing and delivery;
- abandoned lease reclaim increments attempts and terminal cleanup is bounded;
- worker `markDispatched/markFailed` requires matching tenant, worker and lease;
- raw secrets sealed before durable outbox persistence;
- outbox dispatch is at-least-once;
- production profile does not weaken baseline compliance.


## 0.1.0 baseline compliance

- `auth.getSession({ context })` with no token returns `ok: true, value: null`.
- Challenge attempts are incremented only when `MethodFailure.countsAsAttempt === true`.
- `ChallengeBinding` does not persist begin-time policy input; complete uses current `AuthContext.policyInput`.
- Method outputs are rejected when `proof.proofMethod` does not equal the executing method.
- Method proof `expiresAt`, when present, must be greater than `now`.
- `IdentityStore.markVerified()` and `CredentialStore.updateStatus()` are covered by store compliance tests.
- `SideEffectDispatcher` receives `SideEffectContext`, not full `AuthContext`.
- `revokeSession()` is idempotent and non-enumerating for active, missing, expired and already-revoked sessions; `SessionStore.revoke()` may return `null` for missing sessions.
- `ValidationIssue.message` is public-safe and never echoes raw input.
- Outbox extension `markDispatched` and `markFailed` are tenant-scoped.


## Mermaid/readability compliance

- `docs/07-DIAGRAMS.md` must stay explanatory and must not introduce behavior that contradicts `spec/contracts/*.d.ts` or `docs/02-FLOWS.md`.
- Mermaid diagrams are non-normative visualizations of normative contracts and matrices.
- Any diagram showing future extension behavior must label it as extension/non-baseline.
- `SideEffectContext` and `DeliveryContext` must remain aliases of `DispatchContext` unless the contracts intentionally diverge.
