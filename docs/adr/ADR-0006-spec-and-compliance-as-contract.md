# ADR-0006: Spec and compliance as contract

## Status

Accepted

## Decision drivers

- Markdown-only contracts are easy to misread.
- Implementation must be checked against executable rules.
- Implementation prompts are useful but must not become source of truth.

## Options considered

### Option A — Documentation-only standard

Pros:
- easy to write.

Cons:
- ambiguous type shapes;
- hard to enforce;
- likely divergence between docs and code.

### Option B — Type declarations + compliance suites

Pros:
- precise contract shape;
- implementation can compile against spec;
- compliance tests prove behavior.

Cons:
- more maintenance work.

## Decision

Use:

```text
spec/contracts/*.d.ts  — normative API shapes, including public/internal shape separation
docs/*.md              — explanation and architecture model
docs/adr/*.md          — rationale and trade-offs
compliance suites      — executable contract proof
implementation prompts — implementation guidance only
```

## Consequences

Positive:
- less ambiguity;
- easier implementation review;
- better long-term stability.

Negative:
- spec updates must be kept in sync with docs and compliance scenarios.

## Revisit when

- a real implementation reveals the spec is too strict or too vague;
- package-level type tests can replace some Markdown examples.
