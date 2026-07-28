# ADR-0001: Modular architecture and composition root

## Status

Accepted

## Decision drivers

- Auth must support multiple auth methods and infrastructure adapters.
- Core must remain small and security-reviewable.
- Applications must control secrets, templates and infrastructure choices.

## Options considered

### Option A — Monolithic auth package

Pros:
- simplest initial usage.

Cons:
- hard to replace storage, token format, delivery or framework adapters;
- high risk of hidden coupling;
- harder to test boundaries.

### Option B — Many role packages with app-owned composition

Pros:
- clear ownership;
- replaceable auth methods and adapters;
- boundary checks can enforce architecture.

Cons:
- more packages and wiring.

## Decision

Use a small core, role-specific packages and an app-owned composition root.

Core imports only contracts. Concrete `method-*`, `store-*`, `token-*`, `carrier-*`, `delivery-*` and `framework-*` packages import contracts and are wired by the application.

## Consequences

Positive:
- strong boundaries;
- easier compliance testing;
- easier future methods/adapters.

Negative:
- slightly more upfront composition code;
- presets may be needed later for ergonomics.

## Revisit when

- package count becomes a real adoption barrier;
- a stable preset layer can reduce wiring without weakening boundaries.


## 0.1.0 refinement

Core config includes `session: SessionConfig` because session expiry needs a stable source of truth, but HTTP carriers, delivery modes, outbox stores and framework adapters remain outside core.
