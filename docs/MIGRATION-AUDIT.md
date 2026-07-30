# Snapshot migration audit

The monorepo package trees were imported from the exact head commits of the 15 open package pull requests. Git history, legacy tags, GitHub Releases, package versions, nested workflows, nested lockfiles, and nested repository metadata were intentionally excluded.

The machine-readable source map is [migration-sources.json](migration-sources.json).

## Review state

At the migration checkpoint:

- 17 pull requests were open, including the organization profile and monorepo pull requests.
- All 225 review threads were resolved.
- No review was pending and no review had a `CHANGES_REQUESTED` state.
- Every local source checkout matched its remote pull request head.

The imported package trees therefore include the complete reviewed source state.

## Preserved review guarantees

Deduplicating infrastructure preserved the review-driven behavior that materially protects packages:

- Public API discovery follows consumer-reachable declarations across `types`, `exports`, conditional targets, `imports`, and `typesVersions`.
- Declaration fingerprints retain semantic JSDoc and reference directives while ignoring ordinary comments and line-ending differences.
- Pull request API policy uses an immutable full base SHA and reads package-relative snapshots from the monorepo Git tree.
- Package boundaries, peer dependency ranges, Node constraints, `sideEffects`, entrypoints, and generated declarations remain checked.
- Publication uses an exact tarball, SHA-512 conflict detection, a CycloneDX SBOM, provenance attestations, bounded registry verification, and clean consumer installation.
- PostgreSQL package and full-stack integration tests run against PostgreSQL 18.

## Intentional reset

All package manifests start at `0.1.0`. Existing GitHub Package versions must be removed during the protected cutover before the new `0.1.0` artifacts can be published. This reset is accepted only because the packages have no consumers.
