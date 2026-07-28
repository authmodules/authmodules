# ADR-0002: Auth method boundary

## Status

Accepted

## Decision drivers

- Password, OTP, OAuth, passkeys and future mechanisms need one mental model.
- Core must not know proof algorithms.
- Methods must not own accounts, sessions or final linking decisions.

## Options considered

### Option A — Core has method-specific APIs

Examples: `signInPassword`, `verifyOtp`, `signInGoogle`, `verifyPasskey`.

Pros:
- easy to understand initially.

Cons:
- core grows with every method;
- method-specific details leak into core;
- harder to keep stable.

### Option B — Generic method operations

Operations: `enroll`, `authenticate`, `begin`, `complete`.

Pros:
- stable core API;
- fits single-step and challenge-based methods;
- future methods can be added without changing core.

Cons:
- helper packages are needed for ergonomic routes.

## Decision

Use auth methods with an operation manifest:

```text
enroll
authenticate
begin
complete
```

Operation presence is the capability source of truth. Convenience wrappers are helpers, not part of the base `Auth` interface.

## Consequences

Positive:
- clear method/core boundary;
- password owns hashing/enrollment material;
- OTP and future magic-link/passkey/OAuth flows share challenge semantics.

Negative:
- applications or helper packages must map user-friendly routes to generic operations.

## Revisit when

- multiple real methods reveal a missing generic operation;
- helper ergonomics become more important than core minimalism.
