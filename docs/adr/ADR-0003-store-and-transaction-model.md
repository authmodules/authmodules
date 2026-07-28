# ADR-0003: Store and transaction model

## Status

Accepted.

## Decision drivers

- Core needs a stable persistence boundary.
- Password-only apps should not require challenge infrastructure.
- Production outbox must not make the baseline store contract heavier.
- False distributed atomicity must be avoided.

## Options considered

### Option A — One monolithic database abstraction

Pros:
- simple initial implementation;
- fewer interfaces.

Cons:
- hard to mix Postgres/Redis;
- unclear transaction scope;
- hard to test slots independently.

### Option B — Store aggregate with durable/session/ephemeral slots

Pros:
- clear semantic areas;
- supports Postgres-only baseline;
- allows Redis for sessions/challenges later;
- optional challenge store for password-only apps.

Cons:
- more interfaces;
- config validation must check required slots.

### Option C — Outbox as core durable store slot

Pros:
- direct transaction wiring from core;
- simpler first outbox prototype.

Cons:
- makes production concern visible in baseline core store;
- couples core store model to one effect implementation.

## Decision

Use `AuthStore` with:

```text
durable   — accounts, identities, credentials
session   — sessions
ephemeral — optional challenges
```

`ChallengeStore` is required only when configured methods support `begin`/`complete`.

Outbox storage is extension-owned by effects-outbox through `OutboxEnqueueStore` and by the worker through `OutboxWorkerStore`, not a required core store slot.

Transaction support is explicit. Core declares every required scope before execution:

```text
TransactionRunner.run({ requiredScopes }, callback)
  -> rejects unsupported scopes before callback
  -> provides a callback-lifetime TransactionContext
  -> sets covers to the accepted scopes
  -> rolls back on thrown error or Result.ok=false
```

Every official store validates transaction identity, callback lifetime, and scope on each operation. Extension dispatchers declare their storage needs through `SideEffectDispatcher.transactionScopes`. Effects-outbox declares `outbox`; synchronous delivery declares none and cannot be combined with required auth-state writes. Core keeps required effects in the auth transaction and dispatches best-effort effects after commit without that transaction.

`TransactionContext` lives in `transaction.d.ts`; extensions may add string scopes such as `outbox`. No distributed transaction guarantee is implied.

## Consequences

Positive:
- simpler baseline core store;
- password-only apps can omit challenge store;
- production outbox can evolve independently;
- transaction boundaries are explicit.

Negative:
- effects-outbox and its store must implement atomic batch enqueue in the declared `outbox` scope;
- config validation is required to catch missing challenge/effects dependencies.

## Revisit when

- production outbox compliance becomes normative;
- multi-store transaction coordination needs stronger guarantees;
- credential-first lookup methods require additional store ports.


## 0.1.0 refinement

`TransactionContext` was moved out of `store.d.ts` so effects and outbox extensions can participate in transactions without depending on store declarations.
