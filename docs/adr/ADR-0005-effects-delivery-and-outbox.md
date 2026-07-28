# ADR-0005: Effects, delivery and outbox

## Status

Accepted.

## Decision drivers

- Auth methods need to request side effects such as OTP email delivery.
- Core should not know SMTP, outbox, sealing mode or worker leases.
- Raw secrets must not be stored in outbox or logs.
- The contract should support sync delivery without production workers.
- The official OTP production composition must atomically persist required delivery with challenge/auth state.

## Options considered

### Option A — Methods call delivery directly

Pros:
- simple happy path.

Cons:
- methods know infrastructure;
- no central policy for required/best-effort effects;
- hard to add outbox.

### Option B — Core owns `sync` / `outbox` config

Pros:
- central behavior;
- easy initial implementation.

Cons:
- core knows delivery/outbox/sealing details;
- core config grows with every effect mode;
- production concerns leak into baseline.

### Option C — Methods return effect requests, core uses a dispatcher port

Pros:
- core knows only `SideEffectDispatcher`;
- sync delivery, outbox and no-op are implementations;
- outbox can evolve without changing core;
- required/best-effort semantics remain visible.

Cons:
- each production composition must choose an explicit dispatcher and delivery guarantee.

## Decision

Methods return `SideEffectRequest` values. Core forwards them to an optional `SideEffectDispatcher`.

Non-state-mutating operations and development/test compositions may use:

```text
@authmodules/effects-sync-delivery
```

The official OTP production composition uses:

```text
@authmodules/effects-outbox
@authmodules/outbox-worker
```

Core dispatches required effects inside the auth-state transaction. Best-effort effects run after commit without the auth transaction so a failed optional enqueue cannot abort persisted auth state.

Delivery messages are template/data-first. Raw secrets may exist only as typed `RawSecretValue` in memory. Durable/outbox persistence may contain only public JSON data and `SealedSecretValue`.

`AuthEventSink` remains best-effort observability in baseline. Required audit must be represented as durable side effect/outbox behavior later.

## Consequences

Positive:
- thinner core config;
- clearer OTP/outbox consistency;
- delivery and outbox are replaceable;
- sync and durable dispatch share one method-facing model.

Negative:
- effect dispatcher compliance is required;
- outbox mode requires sealing before persistence;
- because methods can emit effects dynamically, missing dispatchers are handled after method execution as `SIDE_EFFECT_FAILED`; required effects are rejected before auth-state persistence.

## Revisit when

- webhooks, push notifications or required audit become first-class effects;
- production outbox profile becomes normative.
