# 08 — Repository settings and first release

This document records the required GitHub configuration and the audited first-release procedure. The `0.1.0` procedure below has been completed against immutable release tags and is retained as the release audit trail. This document does not authorize remote changes, pushes, tags, or package publication.

## Repository metadata

Each package repository uses its `package.json` description as the GitHub description and its package keywords as topics. The organization profile repository describes the ecosystem as a whole; the central `authmodules` repository owns architecture, specification, cross-package verification, and release coordination.

Package repositories must remain public, independently versioned, and limited to one responsibility.

| Repository | Description | Topics |
| --- | --- | --- |
| `.github` | Community health files and organization profile for AuthModules. | `authmodules`, `authentication`, `identity`, `security`, `typescript` |
| `authmodules` | Architecture, specifications, integration tests, and release coordination for the AuthModules ecosystem. | `authmodules`, `authentication`, `identity`, `security`, `typescript` |
| `carrier-cookie` | Secure cookie token transport instructions for framework-neutral AuthModules integrations. | `authmodules`, `authentication`, `cookies`, `http`, `typescript` |
| `contracts` | Framework-neutral TypeScript contracts for modular authentication and identity systems. | `authmodules`, `authentication`, `contracts`, `identity`, `typescript` |
| `core` | Policy-driven orchestration for modular authentication, identities, challenges, and sessions. | `authmodules`, `authentication`, `identity`, `orchestration`, `typescript` |
| `crypto-node` | Secure Node.js randomness, hashing, password hashing, and secret sealing for AuthModules. | `authmodules`, `authentication`, `crypto`, `node`, `typescript` |
| `delivery-email-smtp` | Template-first SMTP email delivery through an injected client for AuthModules. | `authmodules`, `authentication`, `email`, `smtp`, `typescript` |
| `effects-outbox` | Transactional sealed outbox enqueueing for reliable AuthModules delivery side effects. | `authmodules`, `authentication`, `effects`, `outbox`, `typescript` |
| `effects-sync-delivery` | Synchronous required and best-effort delivery dispatch for AuthModules side effects. | `authmodules`, `authentication`, `delivery`, `effects`, `typescript` |
| `framework-express` | Explicit-tenant Express request, session, and response mutation adapter for AuthModules. | `authmodules`, `authentication`, `express`, `framework`, `typescript` |
| `guard-memory` | Bounded in-memory authentication attempt guard for local and single-process AuthModules use. | `authmodules`, `authentication`, `guard`, `rate-limit`, `typescript` |
| `method-otp` | Destination-bound one-time-password challenges and verification for AuthModules. | `authmodules`, `authentication`, `mfa`, `otp`, `typescript` |
| `method-password` | Password enrollment and authentication with pluggable hashing for AuthModules. | `authmodules`, `authentication`, `identity`, `password`, `typescript` |
| `outbox-worker` | Lease-aware outbox delivery worker with final-boundary secret unsealing for AuthModules. | `authmodules`, `authentication`, `outbox`, `typescript`, `worker` |
| `store-postgres` | Transactional PostgreSQL storage for AuthModules auth records and durable delivery outbox. | `authmodules`, `authentication`, `outbox`, `postgres`, `store`, `typescript` |
| `testkit` | Compliance suites, deterministic fixtures, and in-memory stores for AuthModules adapters. | `authmodules`, `authentication`, `compliance`, `testing`, `typescript` |
| `token-opaque` | Opaque session token issuance and protected hash identification for AuthModules. | `authmodules`, `authentication`, `opaque-token`, `tokens`, `typescript` |

## Recommended settings

- Issues enabled in package and central repositories; organization-wide questions and design discussions live only in `authmodules` Discussions.
- Issues disabled in `.github`; its community files route support and security reports to the central repository.
- Projects and Wiki disabled unless a concrete maintenance need appears.
- Private vulnerability reporting, dependency graph, Dependabot alerts, Dependabot security updates, secret scanning, and push protection enabled where GitHub supports them.
- Non-provider secret patterns and validity checks enabled only when the organization has GitHub Secret Protection; repository API requests cannot enable these features on an unsupported plan.
- Squash merge enabled; merge commits disabled; rebase merge optional.
- Head branches deleted automatically after merge.
- Default branch named `main`.
- Default workflow permissions set to read-only; each dedicated package release workflow grants `contents: read`, `packages: write`, and the short-lived `id-token`, `attestations`, and `artifact-metadata` write permissions required for signed public release evidence.
- A protected `github-packages` environment configured for package publication, with deployment branches restricted to the protected `main` branch.
- A tag-creation ruleset blocks creation of package tags matching `v*` and central plan tags matching `release-plan/v*`, with a bypass limited to the intended release operator or release App.
- A separate immutable-tag ruleset blocks updates and deletions for the same patterns with no bypass. Do not combine creation with update/deletion restrictions in one ruleset: a creation bypass would otherwise also permit moving or deleting a release tag.

## Main branch ruleset

- Pull requests required after the initial import.
- Required status check named `check` on the exact head commit.
- Required conversation resolution.
- Force pushes and branch deletion blocked.
- Administrators included after the initial repositories and checks are confirmed.
- One approving review is recommended once a second maintainer is available; it must not create an impossible solo-maintainer rule during bootstrap.

An empty repository has no branch on which the required workflow can run. Import the reviewed initial commit with one explicit `main:main` refspec under a temporary, narrowly scoped bootstrap bypass. Confirm the exact remote head and first successful check, remove that bypass, then activate the pull-request requirement. Main protection must be fully active before any release tag is created.

The PostgreSQL repository additionally runs its real PostgreSQL integration test in the required workflow.

## Package publication order

Before the first publication, record a reviewed ecosystem release manifest that pins the exact initial commit, `v0.1.0` tag, version, and SHA-512 tarball integrity of every package repository. The manifest can only be finalized after all package initial commits exist and their worktrees are clean; no placeholder commit identifiers or digests are permitted. Generate it with `npm run release:prepare -- 0.1.0`, validate it with `npm run release:check`, and review the resulting diff. Commit the final manifest and release helpers, then protect and create `release-plan/v0.1.0` at that exact central commit. Package publication always resolves its inputs from this immutable plan tag.

Each package repository contains an explicitly dispatched GitHub Packages workflow that runs only from its protected `main` branch. The operator supplies only the exact release plan identifier. The workflow checks out `release-plan/v<release>`, resolves the package and contracts tags from that plan, verifies both tag revisions and package versions, runs the package checks, verifies the local tarball against the planned SHA-512 digest, and compares that digest with GitHub Packages. It publishes only when that exact version is absent, then verifies registry integrity with bounded retries. A rerun is safe when the registry already contains identical contents and fails closed when the contents differ.

Create the package GitHub Release only after the registry version has been verified and made public. This order prevents a public release object from claiming success before the package exists. No npmjs token, OIDC provenance permission, or long-lived publishing secret is used.

GitHub Packages requires authentication even for public packages. Local consumers configure the `@authmodules` scope for `https://npm.pkg.github.com` and use a classic personal access token with `read:packages`; GitHub Actions consumers use `GITHUB_TOKEN` with `packages: read`.

The initial central release manifest is `releases/0.1.0.json` using schema version 2. It is created only after the 15 package commits are final. Every entry records the exact repository, full 40-character commit revision, protected tag, independently managed package version, and canonical SHA-512 SRI digest of the packed artifact. For the initial release every package version and tag are `0.1.0` and `v0.1.0`.

The `published-consumer` workflow accepts only an exact release identifier, must be dispatched from the matching protected `release-plan/v<release>` ref, derives package versions, integrities, and checkout tags from the committed file, checks that every checked-out tag resolves to the recorded revision, installs the complete package set, and verifies each registry digest against the release plan. It rejects mutable branch names, shortened hashes, version ranges, missing repositories, and caller-provided version or integrity JSON.

1. Confirm the organization Package Creation setting permits public packages. GitHub's npm registry creates a new package as private, so retain the explicit post-publication visibility step.
2. Confirm every local package repository contains one reviewed initial commit and a clean worktree.
3. From the central repository, run `npm run release:prepare -- 0.1.0` to record the exact 15 package revisions and tarball digests in `releases/0.1.0.json`. Validate it with `npm run release:check`, review the complete manifest diff, then finalize the central repository's reviewed initial commit.
4. Create or configure the 16 new package and central repositories without changing the verified local trees. Create them empty: do not initialize a README, license, or ignore file on GitHub.
5. Configure the read-only workflow default, security features, protected `github-packages` environment, and both tag rulesets. Do not create release tags yet.
6. Push `contracts` first using only the explicit bootstrap refspec, confirm its exact remote head and required check, then activate the full main ruleset and remove the bootstrap bypass.
7. Push runtime and adapter repositories only after the contracts repository is available to their CI checkouts. For each repository, confirm the exact remote head and required check, activate the full main ruleset, and remove the bootstrap bypass.
8. Push the central `authmodules` repository last because its workflow checks out the complete ecosystem. Confirm its exact remote head and required check, activate the full main ruleset, and remove the bootstrap bypass.
9. Submit the existing `.github` launch changes through its protected main branch after all support and security routes exist; confirm its exact remote head and required check.
10. Verify that every main branch is protected and every bootstrap bypass is gone. Test that an unauthorized tag creation is denied; test that tag update and deletion are denied even to the release operator before creating real release tags.
11. Confirm the manifest revisions equal the 15 exact package remote heads. Create protected package `v0.1.0` tags at those revisions and create protected central `release-plan/v0.1.0` at the reviewed central commit.
12. Dispatch the `contracts` package workflow from its default branch with release identifier `0.1.0`. Confirm registry integrity, explicitly change the new package visibility to public, grant the central `authmodules` repository Actions read access to the package, verify the public visibility setting and an authenticated installation, and only then create the `contracts` GitHub Release for `v0.1.0`.
13. Dispatch each remaining package workflow with release identifier `0.1.0`. After each successful integrity verification, make the package public, grant the central repository Actions read access, verify it, and then create that repository's GitHub Release. A package version becomes externally ready only after all five states agree: protected tag, plan revision, planned tarball digest, registry integrity, and public visibility.
14. Dispatch the central workflow at ref `release-plan/v0.1.0` with release identifier `0.1.0`. Require both the exact-source ecosystem check and `published-consumer` installation to pass.
15. Create the central `authmodules` `v0.1.0` tag at the same reviewed commit and publish its GitHub Release only after the central workflow succeeds; it is not a package.

Use only explicit repository and branch/tag refspecs during bootstrap. Never use `git push --mirror`, `git push --all`, or a broad refspec: local backup refs are recovery state and must not become public.

If a package workflow fails before the registry write, fix the source or release machinery with a new reviewed plan; never move or replace an existing protected plan/package tag. If the publish result is ambiguous, query the exact package version and compare registry integrity. Rerun when it is absent or identical; stop when it differs. Never reuse a published version or move its tag. A bad public artifact is repaired with a new patch version because public visibility cannot be reversed. The central release remains blocked until the published consumer passes for the complete plan.

The organization profile repository is not versioned as `0.1.0`.

## Ongoing patch releases

After the initial release, package versions remain independent. A release plan records the complete compatible package set, while only changed packages receive new package tags, registry versions, and GitHub Releases. Unchanged packages retain their existing immutable tags and versions in the new plan.

Before creating a plan, every package must pass its local check with the exact toolchain in its lockfile. Public package entrypoints and generated declarations are recorded in `api-surface.json`. An initial snapshot does not force a version change; later public API changes require at least the next minor version before `1.0.0` and the next major version after `1.0.0`. This conservative rule deliberately treats every public surface change as potentially breaking.

Package pull requests run dependency review and CodeQL in addition to the package check. Dependabot proposes npm and GitHub Actions updates on a bounded weekly schedule. These checks complement, but do not replace, code review and release-plan integrity verification.

For release plans containing `scripts/prepare-package-release-evidence.js`, each package workflow creates one exact tarball, verifies its SHA-512 integrity against the immutable plan, and publishes that same file. After registry integrity is confirmed, the workflow creates GitHub artifact attestations for build provenance and a CycloneDX SBOM, then retains the tarball and SBOM as workflow evidence for 90 days. Historical release plans remain rerunnable through the legacy publication path and do not claim attestations they did not create.

The release operator still creates protected tags and GitHub Releases explicitly. Release automation must fail closed on a missing plan, moved tag, mismatched revision, changed tarball integrity, unexpected dependency shape, or registry conflict. No workflow may create, move, or delete an immutable release tag implicitly.

Run `npm run release:preflight -- <release>` before and after each release phase. It validates the committed manifest, resolves every package tag to a full remote commit, checks GitHub Packages and GitHub Release presence, and confirms that the central plan and release tags cannot diverge. It is deliberately read-only: protected tag creation, workflow dispatch, and GitHub Release creation remain explicit operator actions.
