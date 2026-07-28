# 02 — Flows

This document defines behavior that is not obvious from type shapes alone. `spec/contracts/*.d.ts` remains normative for API shape; these matrices are normative for flow semantics.

## Core operations

| Operation | Purpose | Method operation | Session possible? |
|---|---|---|---:|
| `enroll` | create/link identity and optional credential | `method.enroll` | yes, only if method returns proof |
| `authenticate` | single-step proof | `method.authenticate` | yes |
| `begin` | start challenge/redirect/link flow | `method.begin` | no |
| `complete` | finish challenge/callback flow | `method.complete` | yes, from stored challenge binding |
| `getSession` | identify current session | none | existing only |
| `revokeSession` | revoke session | none | no |

## Shared method rules

```text
method.validate(input, MethodValidationContext)
  -> parses method-specific input
  -> returns ValidatedMethodInput.value
  -> returns canonical IdentityLookup when known

method.run(value, MethodExecutionContext)
  -> receives the same canonical lookup when validation or stored challenge produced one
  -> returns method-owned material, side effects and/or proof
```

The method operation registry intentionally erases concrete input types. Concrete methods stay strongly typed internally; core calls `validate()` and then passes only the value produced by that same validator to `run()`.

## Identity binding invariant

Identity binding is mandatory. If validation or a stored challenge produced `IdentityLookup`, core verifies that method outputs match it:

```text
methodId
methodKind
subject
subjectKind
```

This applies to:

```text
MethodEnrollResult.identity
MethodEnrollResult.proof.primaryIdentity when proof exists
MethodAuthenticateResult.proof.primaryIdentity
MethodCompleteResult.proof.primaryIdentity
method.complete.validate().lookup when stored ChallengeRecord.lookup exists
```

Mismatch is `IDENTITY_BINDING_MISMATCH` and must not create account, identity, credential or session records.

## Unified attempt lifecycle

| Stage | `enroll` | `authenticate` | `begin` | `complete` |
|---|---|---|---|---|
| Load existing state first? | no | no | no | load challenge by tenant + id |
| Validate input | method validate | method validate | method validate | method validate after challenge load/precheck |
| Lookup source | validation lookup | validation lookup | validation lookup | stored challenge lookup is authoritative |
| Guard before attempt | after validation | after validation | after validation/preflight | after challenge precheck + validation |
| Policy start-attempt | after guard | after guard | after guard | after guard |
| Operation preflight | optional conflict/link checks | load identity/credential | account preflight before challenge delivery | challenge status/expiry/attempt precheck before method run |
| Method run | enroll | authenticate | begin | complete |
| Output validation | identity/proof binding | proof binding | expires/maxAttempts/material | proof binding |
| Account resolution | yes | yes | stored in challenge binding only | yes, from challenge binding |
| Session creation | only if proof + session request | if session request | no | if challenge binding has session request |
| Guard after attempt | success/failure with reason | success/failure with reason | success/failure with reason | success/failure with reason |

`guard.beforeAttempt` runs after core has a canonical lookup when one is available. `guard.afterAttempt` runs exactly once for each attempted operation outcome and receives the internal reason plus an explicit `countsAsAttempt` decision for failures. Guards must not infer accounting from reason strings.

Policy and guard attempt checks receive the executing `method: MethodRef`, not only `methodId`, so rate limits and policy decisions can use both `methodId` and `methodKind` without parsing namespaces.

## Session TTL

`CreateAuthConfig.session.defaultTtlSeconds` is the default source for session expiry.

```text
session field missing
  -> do not create a session

session: {}
  -> create a session using config.session.defaultTtlSeconds

session: { ttlSeconds }
  -> create a session using ttlSeconds only if it does not exceed config.session.maxTtlSeconds when max is configured
```

No `AuthProof` means no session. Core must ignore session creation requests for method operations that do not return proof.

## Password sign-up / enroll

```text
auth.enroll
  -> method.validate(input, context)
      returns canonical lookup when possible
  -> guard.beforeAttempt when configured
  -> policy start-attempt
  -> method.enroll.run(value, context.lookup)
      returns identity + optional credentialMaterial + optional proof
  -> core verifies MethodEnrollResult.identity matches lookup when lookup exists
  -> if proof exists, core verifies proof.primaryIdentity matches lookup when lookup exists
  -> policy accept-enrollment with identity + hasCredentialMaterial
  -> policy resolve-account with identity/proof/lookup/mode
  -> core resolves account according to AccountResolutionMode
  -> core creates account/identity/credential records
  -> if session field is present and proof exists:
       resolve TTL from request ttl or config.session.defaultTtlSeconds
       enforce config.session.maxTtlSeconds when present
       policy create-session receives requested/resolved TTL and expiresAt
       token.issue() -> TokenIssueResult(raw + tokenHash)
       store SessionRecord(tokenHash)
       return IssuedTokenView(raw + issuedAt/expiresAt)
  -> dispatch side effects through SideEffectDispatcher if present
  -> guard.afterAttempt
```

`policy accept-enrollment` runs after `method.enroll.run()`, because it needs the `IdentityClaim` returned by the method.

## Password sign-in / authenticate

```text
auth.authenticate
  -> method.validate(input, context)
      returns IdentityLookup
  -> guard.beforeAttempt when configured
  -> policy start-attempt
  -> core loads IdentityRecord + CredentialRecord
  -> method.authenticate.run(value, context.lookup + optional credentialMaterial)
      returns AuthProof or MethodFailure
      password method performs dummy hash work when credentialMaterial is missing
  -> core verifies identity/lookup binding
  -> core maps failure to AuthFailure/PublicAuthError
  -> core resolves account using proof/identity/lookup/mode
  -> if session field is present:
       resolve TTL from request ttl or config.session.defaultTtlSeconds
       enforce config.session.maxTtlSeconds when present
       policy create-session receives requested/resolved TTL and expiresAt
       token.issue()
       store SessionRecord(tokenHash)
  -> return AuthSuccess with views only
  -> guard.afterAttempt
```

Password mismatch is a normal method/crypto verification result, not an infrastructure failure. Unknown identities and missing credentials still execute method-side password work before returning the same public authentication failure.

## Challenge begin

Correct order:

```text
auth.begin
  -> method.validate(input, context)
      returns IdentityLookup when known
  -> config validation requires ChallengeStore if any begin/complete method exists
  -> account preflight when lookup is known
  -> guard.beforeAttempt when configured
  -> policy start-attempt
  -> core generates challengeId via idGenerator.generate({ kind: 'challenge' })
  -> method.begin.run(value, context.lookup + context.challenge.challengeId)
      returns ChallengeMaterial + expiresAt + maxAttempts + sideEffects + publicData
  -> validate begin output
  -> core stores ChallengeRecord:
       challengeId
       methodId/methodKind
       lookup
       material
       maxAttempts
       ChallengeBinding(account/session/startedByActor)
  -> core dispatches side effects through SideEffectDispatcher if present
  -> return challengeId + expiresAt + publicData
  -> guard.afterAttempt
```

Challenge material is returned before `ChallengeRecord` is persisted, because the record cannot be complete without method-owned verifier/material.

### Begin account preflight

When `method.validate()` returns a lookup, core should avoid sending challenges for flows that are already impossible or unsafe.

| Mode | Lookup known? | Identity state | Begin behavior |
|---|---:|---|---|
| `require-existing-identity` | yes | exists | allow begin |
| `require-existing-identity` | yes | missing | fail before delivery; map like challenge/login failure without leaking account existence |
| `require-existing-identity` | no | unknown | allow begin only for methods that cannot know subject until complete |
| `create-new-account` | yes | missing | allow begin |
| `create-new-account` | yes | exists | fail with conflict before delivery |
| `create-account-if-identity-missing` | yes | exists or missing | allow begin; final resolution still happens on complete |
| `link-to-actor-account` | yes | missing | require current account actor, then allow begin |
| `link-to-actor-account` | yes | exists, same actor account | allow/idempotent |
| `link-to-actor-account` | yes | exists, different account | fail with conflict before delivery |

If lookup is not known at begin, final account resolution happens at complete from the proof and stored challenge binding.

## Challenge complete

```text
auth.complete
  -> load ChallengeRecord by tenantId + challengeId
  -> precheck challenge:
       tenant matches
       status is pending
       expiresAt > now
       attempts < maxAttempts
  -> select method from ChallengeRecord.methodId
  -> method.complete.validate(input, context)
  -> if method.complete.validate() returns lookup and ChallengeRecord.lookup exists:
       verify both lookups match; otherwise fail with IDENTITY_BINDING_MISMATCH
  -> guard.beforeAttempt when configured
  -> policy start-attempt
  -> method.complete.run(value, challengeMaterial + stored lookup)
  -> if method failure has countsAsAttempt === true:
       ChallengeStore.recordFailedAttempt(expectedVersion)
       handle RecordFailedAttemptResult: recorded | attempts-exceeded | expired | version-conflict
       guard.afterAttempt exactly once with failure reason
       return safe failure
  -> if method failure does not count as attempt:
       do not increment challenge attempts
       guard.afterAttempt exactly once with failure reason
       return safe failure
  -> if proof succeeds:
       verify proof/lookup binding against stored ChallengeRecord.lookup when it exists
       ChallengeStore.consumePending(expectedVersion)
       resolve account using stored ChallengeBinding
       re-check current AuthContext.actor for link-to-actor-account flows
       optionally create session using stored ChallengeBinding.session
       guard.afterAttempt exactly once with success outcome
       return AuthSuccess
```

`CompleteInput` does not contain `methodId`; the stored challenge is the source of truth. For complete flows, `ChallengeRecord.lookup` is authoritative. Complete-time input may refine or repeat it, but must not override it.

`ChallengeBinding.startedByActor` is binding/diagnostic context only. It must not replace current authorization checks during `complete()`.

## Method output validation table

| Method output | Core validation |
|---|---|
| `MethodEnrollResult.identity` | methodId/methodKind must equal executing method; must match validation lookup when lookup exists |
| `MethodEnrollResult.proof` | `proofMethod` must equal executing method; primary identity must match validation lookup when proof and lookup exist; `expiresAt`, if present, must be greater than `now` |
| `MethodAuthenticateResult.proof` | `proofMethod` must equal executing method; primary identity must match validation lookup when lookup exists; `expiresAt`, if present, must be greater than `now` |
| `MethodBeginResult.expiresAt` | must be greater than `now` |
| `MethodBeginResult.maxAttempts` | must be a positive integer |
| `MethodBeginResult.challengeMaterial.schemaVersion` | must be non-empty |
| `method.complete.validate().lookup` | must match stored `ChallengeRecord.lookup` when both exist |
| `MethodCompleteResult.proof` | `proofMethod` must equal executing method; primary identity must match stored challenge lookup when lookup exists; `expiresAt`, if present, must be greater than `now` |
| `AuthProof.authTime` | must not be unreasonably in the future |
| `additionalIdentities` | proof evidence only; `(methodId, subject)` must be unique within the proof; core does not persist or link them |
| `MethodAuthenticateResult.credentialMaterial` | full material replacement only; core supplies expected record version; method must not define merge semantics |
| `sideEffects` | required effects fail if no dispatcher is configured |

## Attempt accounting

Core increments challenge failed attempts only when the method failure explicitly says so. `ChallengeStore.recordFailedAttempt()` is not a generic error counter. It is only for challenge verification failures that consume an allowed attempt, and it returns an explicit `RecordFailedAttemptResult` instead of hiding control-flow outcomes as infrastructure failures.

The same method flag is propagated to `GuardAfterAttemptInput.outcome.countsAsAttempt`. Infrastructure, policy, validation, and persistence failures set it to `false`.

```text
MethodFailure.countsAsAttempt === true
```

| Failure source | `guard.afterAttempt`? | `ChallengeStore.recordFailedAttempt()`? |
|---|---:|---:|
| validation failure | yes | no |
| guard denied | yes | no |
| policy denied | yes | no |
| password mismatch | yes | no challenge |
| OTP mismatch / verifier mismatch | yes | yes, only when `MethodFailure.countsAsAttempt === true` |
| method failure without `countsAsAttempt=true` | yes | no |
| identity binding mismatch | yes | no by default; implementations may choose a security-specific method failure that counts |
| store unavailable | yes | no |
| required side effect failed | yes | no |
| internal exception | yes | no |


### Failed-attempt store result

`ChallengeStore.recordFailedAttempt()` returns a control result:

| Result | Meaning | Core behavior |
|---|---|---|
| `recorded` | attempt was recorded and challenge remains usable or updated | return challenge failure |
| `attempts-exceeded` | attempt was recorded and challenge is now terminal/failed | return challenge failure and do not allow further verification |
| `expired` | challenge expired before attempt could be recorded | return challenge failure, no retry detail |
| `version-conflict` | concurrent update won | reload/retry according to implementation policy or fail safely |

These are not store outage cases. Real infrastructure failures still use `Result.ok=false` with `StoreFailure`.

## Credential and identity lifecycle mutations

`CredentialStore.updateStatus()` owns credential enable/disable transitions. `IdentityStore.markVerified()` owns verification timestamp updates. Core must use these store methods instead of mutating records out of band.

| Record | Lifecycle field | Store mutation |
|---|---|---|
| Account | `status` | `AccountStore.updateStatus()` |
| Identity | `verifiedAt` | `IdentityStore.markVerified()` |
| Credential | `status` | `CredentialStore.updateStatus()` |
| Credential | `material.schemaVersion` + store optimistic `version` | `CredentialStore.replaceMaterial()` |
| Session | `status` | `SessionStore.revoke()` / expiry cleanup |
| Challenge | `status/attempts` | `consumePending()` / `recordFailedAttempt()` / cleanup |

## Credential material replacement

Credential updates are full material replacements, not patches.

```text
method receives current credential material
authenticate method returns credentialMaterial when upgrade/rotation is needed
core calls CredentialStore.replaceMaterial({ expectedVersion, material })
store replaces the full material atomically
```

There is no shallow merge/delete semantics in the baseline contract.

## Session lookup

`getSession()` distinguishes “no active session” from infrastructure failure.

| Case | Result |
|---|---|
| missing token or malformed token | `ok: true, value: null` plus diagnostic event when possible |
| token hash not found | `ok: true, value: null` |
| token tenant mismatch | `ok: true, value: null` |
| session expired | `ok: true, value: null` |
| session revoked | `ok: true, value: null` |
| store unavailable | `ok: false` with `TEMPORARILY_UNAVAILABLE` public error |
| unexpected token/crypto component failure | `ok: false` with safe auth failure |

`GetSessionInput.token` is optional. Framework/carrier helpers may pass `undefined` when no token is present. Framework-level `requireSession()` helpers may map `null` to public `SESSION_INVALID` responses.

## Session revocation

Base `revokeSession()` is idempotent and non-enumerating for logout-style use.

| Case | Result |
|---|---|
| active session | revoke and return `ok: true` |
| already revoked session | `ok: true` |
| expired session | `ok: true` |
| missing session | `ok: true`; do not reveal whether the session existed; `SessionStore.revoke()` may return `null` |
| store unavailable | `ok: false` with safe infrastructure failure |

`SessionStore.revoke()` is idempotent and may return `SessionRecord | null`; missing/null is still a successful non-enumerating logout result at core level. An account actor may revoke only a session owned by that account, while a system actor may revoke any session in the tenant. A cross-account target is handled as the same non-enumerating no-op as a missing session. `PolicyCheck.revoke-session` may receive the loaded `SessionView` only after this ownership check, and policy/framework code must not leak session existence to untrusted clients by default. Strict admin/session-management helpers may expose more detailed behavior outside the baseline core contract.

## Token/session split

```text
token.issue()
   ├── raw token   -> IssuedTokenView -> carrier -> HTTP response
   └── tokenHash   -> SessionRecord   -> store
```

`TokenIssueResult` contains only `raw` and `tokenHash`. Core owns `issuedAt`/`expiresAt` and builds `IssuedTokenView`. Public results use `IssuedTokenView`.

## Account resolution matrix

| Mode | Identity state | Actor required? | Result |
|---|---|---:|---|
| `create-new-account` | missing | no | create account + identity |
| `create-new-account` | exists | no | `IDENTITY_CONFLICT` -> `CONFLICT` |
| `require-existing-identity` | exists | no | use linked account |
| `require-existing-identity` | missing | no | login-like flows map to `AUTHENTICATION_FAILED`; challenge flows map to `CHALLENGE_FAILED` |
| `create-account-if-identity-missing` | missing | no | create account + identity |
| `create-account-if-identity-missing` | exists | no | use existing linked account |
| `link-to-actor-account` | missing | yes | create identity linked to current actor account |
| `link-to-actor-account` | exists, same account | yes | success/idempotent |
| `link-to-actor-account` | exists, another account | yes | `IDENTITY_CONFLICT` -> `CONFLICT` |

## Status transition tables

### Account

```text
active   -> disabled | deleted
disabled -> active | deleted
deleted  -> terminal
```

### Credential

```text
active   -> disabled
disabled -> active
```

### Session

```text
active  -> revoked | expired
revoked -> terminal
expired -> terminal
```

### Challenge

```text
pending  -> consumed | expired | failed
pending  -> pending   // failed attempt increments attempts only when MethodFailure.countsAsAttempt === true
consumed -> terminal
expired  -> terminal
failed   -> terminal
```

### Outbox extension

```text
pending    -> claimed | dead
failed     -> claimed | dead
claimed    -> dispatched | failed | dead
dispatched -> terminal
dead       -> terminal
```

`failed` records become claimable directly when `availableAt <= now`; there is no intermediate transition back to `pending`. Expired pending, failed, or claimed records become `dead`, and an expired lease moves a claimed record to `failed` or `dead` after incrementing its attempt count.

`cleanupTerminal()` physically deletes dispatched or dead records. Deletion also releases the store-level idempotency key, so retention must be long enough to cover every legitimate producer retry window. Keep every sealing key available while any record encrypted under it can still be claimed, retried, inspected, or deliberately replayed; retire the key only after those records have passed the retention policy and been removed.

## Side-effect dispatcher rule

Methods may return `SideEffectRequest[]`. Core passes them to `SideEffectDispatcher` when one is configured. The dispatcher receives privacy-narrowed `SideEffectContext`, not full `AuthContext`.

For operations that persist state, core partitions the batch by policy: required effects run inside the auth transaction, while best-effort effects run after commit without that transaction. Result indexes are mapped back to the original method batch.

| Situation | Dispatcher result | Auth operation result |
|---|---|---|
| all required effects accepted/performed/deferred | `ok: true` | may continue |
| any required effect fails | `ok: false` | operation fails with safe auth failure |
| only best-effort effects fail | `ok: true, failed[]` | operation succeeds; failures are diagnostic |
| required effect produced and no dispatcher configured | none | operation fails with `SIDE_EFFECT_FAILED` before auth-state persistence |
| only best-effort effects produced and no dispatcher configured | none | operation may succeed; emit diagnostic event when possible |
| dispatcher infrastructure unavailable before effect classification | `ok: false` | operation fails safely |

Raw secrets may be dispatched only in memory. Durable/outbox dispatchers must seal raw secrets before persistence and may persist only public data plus `SealedSecretValue`.

## Delivery locale precedence

Delivery rendering uses this precedence:

```text
DeliveryMessage.locale ?? DeliveryContext.locale
```

If neither is present, the delivery transport uses its own default locale.

## Side-effect consistency matrix

Baseline synchronous delivery cannot participate in a database transaction. Core therefore rejects required synchronous effects on operations that write auth state, even when the store has a transaction runner. Use a dispatcher with declared `transactionScopes`, such as effects-outbox, for atomic persistence.

`TransactionRunner.run({ requiredScopes }, callback)` receives every scope before the callback starts. The runner must reject unsupported scopes without invoking the callback, and each store operation must reject a transaction context that does not cover its own scope. Core does not open a transaction when the required scope list is empty.

| Dispatch style | Auth state committed? | External effect | Result |
|---|---:|---:|---|
| required synchronous effect with auth-state writes | no | not dispatched | operation fails before persistence; choose a transactional dispatcher |
| required synchronous effect without auth-state writes | unchanged | sent with a stable logical key; duplicates depend on provider deduplication | provider failure fails the operation |
| outbox required in the same declared transaction scopes, enqueue succeeds | yes | deferred | auth state and the required outbox partition commit together in original relative order |
| outbox required in the same declared transaction scopes, enqueue fails | no | not dispatched | transaction rolls back and the operation fails |
| best-effort dispatcher fails or throws after commit | yes | failed | operation succeeds; diagnostic event is emitted when possible |

Stable baseline side effects are delivery-only. Non-delivery side effects are future extension contracts.

## Visual diagrams

The same flow rules are summarized visually in `docs/07-DIAGRAMS.md`. The diagrams are explanatory and must not override the contract shapes in `spec/contracts/*.d.ts` or the matrices in this file.
