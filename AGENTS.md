# AuthModules Repository Guidance

## Language

- Repository artifacts are written in English.
- User-facing conversation follows the user's language.

## Architecture

- This repository is a development monorepo, not a runtime monolith.
- Every directory under `packages/` owns one publishable `@authmodules/*` package and one explicit responsibility.
- Cross-package runtime imports are forbidden unless declared by the boundary checker.
- `@authmodules/contracts` remains type-only and is consumed through ordinary semver peer ranges.
- Do not introduce ORM lock-in or copy code from unrelated authentication systems.

## Changes

- Use npm 11 workspaces and keep only the root `package-lock.json`.
- Keep package source, tests, API snapshots, README, and license in the owning workspace.
- Keep shared validation and release automation under `scripts/` and `.github/workflows/`.
- Public API changes must update the package API snapshot and satisfy the conservative pre-1.0 version policy.
- Pull request titles follow Conventional Commits because squash titles drive Release Please.

## Verification

- Run the affected package check while iterating.
- Run the full root `check` before pushing changes that affect shared infrastructure, package boundaries, or releases.
- Release preparation is manual. Package publication occurs only after a reviewed Release Please pull request changes the committed manifest on `main`.
