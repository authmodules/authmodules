# 03 — Contract map

`spec/contracts/*.d.ts` is the normative source of truth. Docs explain it; compliance tests must prove it.

## Files

| File | Purpose |
|---|---|
| `result.d.ts` | Common `Result<T, E>` and validation failure shape |
| `primitives.d.ts` | IDs, method refs, subject refs, context, proof, account resolution, clocks |
| `security.d.ts` | Raw/protected/sealed secret types, secret factory, public/private/delivery data |
| `errors.d.ts` | Public errors, internal reasons and component failures |
| `crypto.d.ts` | Crypto provider, password hasher and sealer contracts |
| `material.d.ts` | Opaque method-owned credential/challenge material |
| `transaction.d.ts` | Shared transaction context, generic transaction runner and transaction failure |
| `method.d.ts` | Auth method operation manifest and operation result shapes |
| `views.d.ts` | Public views returned by core |
| `core.d.ts` | Core API, session config, policy hook and `createAuth()` config |
| `store.d.ts` | Account, identity, credential, session and optional challenge stores |
| `token.d.ts` | Token format, token issue result and public token view |
| `carrier.d.ts` | Framework-neutral HTTP token carrier and mutations |
| `delivery.d.ts` | Template/data-first delivery transport |
| `effects.d.ts` | Delivery-only baseline side-effect request, narrow `SideEffectContext` and dispatcher port |
| `observability.d.ts` | Best-effort event sink |
| `guard.d.ts` | Stable optional production-hardening hook |
| `extensions.d.ts` | Optional extension export barrel |
| `outbox.d.ts` | Optional durable outbox extension, exported via `extensions.d.ts` |

## Normative vs explanatory

```text
spec/contracts/*.d.ts              normative stable API shape
spec/contracts/extensions.d.ts     optional outbox extension exports
docs/*.md                          explanatory behavior, matrices and examples
docs/adr/*.md                      why decisions were made
guides/*.md                        non-normative examples and authoring guidance
implementation prompts             implementation guidance only
```


## Visual contract map

`docs/07-DIAGRAMS.md` contains Mermaid diagrams and quick-reference tables. It is explanatory: diagrams clarify ownership and flow order, while `spec/contracts/*.d.ts` and the behavior matrices remain normative.

## Core collaborators

The 0.1.0 core has a deliberately small collaborator set:

```ts
createAuth({
  store,
  methods,
  token,
  session,
  effects,
  policy,
  guard,
  eventSink,
  clock,
  idGenerator,
})
```

Required for baseline:

```text
store
methods
token
session
clock
idGenerator
```

Optional:

```text
effects    — required at runtime only when required side effects are produced
policy     — one allow/deny hook
guard      — stable optional production-hardening hook
eventSink  — best-effort observability
```

## Config validation checklist

`createAuth(config)` returns `Result<Auth, ConfigValidationFailure>` and must validate at least:

- method registry key equals `method.methodId`;
- no duplicate or empty method IDs;
- method IDs use stable dot namespaces;
- token format exists;
- `session.defaultTtlSeconds` is positive;
- `session.maxTtlSeconds`, if present, is not lower than the default;
- session request presence means create session; absence means no session;
- required store slots exist;
- if any method has `begin` or `complete`, `store.ephemeral?.challenges` exists;
- effects dispatcher presence is not guessed from method internals;
- required effects without a dispatcher fail at runtime;
- side-effect dispatchers receive `SideEffectContext`, not full `AuthContext`;
- `clock` and `idGenerator.generate` exist;
- carrier is not in core config;
- production extensions do not weaken baseline invariants.

## Minimal dependency graph

```text
core -> stable contracts
method-* -> contracts/{method,material,effects,crypto/security as needed}
store-* -> contracts/{store,material,security,transaction}
token-* -> contracts/{token,crypto/security}
carrier-* -> contracts/{carrier,security}
delivery-* -> contracts/{delivery,security}
effects-* -> contracts/{effects,delivery,transaction} + optional extensions/{outbox} + crypto/store as needed
framework-* -> contracts/{carrier,security,errors}
outbox-worker-* -> contracts/extensions + delivery/effects as needed
```

## Stable root exports

```text
spec/contracts/index.d.ts      stable baseline contracts plus optional guard hook
spec/contracts/extensions.d.ts optional outbox extension exports
```

Root imports should not make outbox look required for baseline. Guard is stable optional: available to core, but not required by baseline compliance.


## 0.1.0 contract notes

- `TokenFormat.identify()` returns `TokenIdentity | null`; null is the normal no-usable-token path.
- `CredentialMaterial.schemaVersion` and `ChallengeMaterial.schemaVersion` are method-material schema versions and are distinct from store optimistic `version` fields.
- `SessionStore.revoke()` is idempotent and may return `SessionRecord | null`.
- `ChallengeStore.recordFailedAttempt()` returns `RecordFailedAttemptResult`, not just a generic record or store failure.
- Policy/guard attempt checks use `method: MethodRef`, so callers do not need to infer `methodKind` from `methodId`.
- `DispatchContext` in `primitives` is the shared privacy-narrowed shape used by side-effect and delivery boundaries. `SideEffectContext` and `DeliveryContext` are role aliases.
