# AuthModules

AuthModules is an open-source TypeScript authentication ecosystem built from small independent packages.

The goal is simple: provide focused building blocks for authentication and identity without owning your application runtime.

## What It Is

- Domain-first auth building blocks.
- Small scoped packages published through GitHub Packages.
- Explicit ports and adapters.
- One development monorepo with explicit package boundaries.
- Independent versions.

## What It Is Not

- Not a hosted auth service.
- Not a UI kit.
- Not an HTTP framework.
- Not an ORM.
- Not a full application template.
- Not a monorepo runtime.

## Architecture

AuthModules separates orchestration, methods, persistence, cryptography, token formats, HTTP carriers, framework adapters, delivery, guards, and reliable outbox processing. Applications compose only the packages they need through the contracts package.

## Release status

This repository contains the complete development workspace: architecture, normative contracts, package implementations, cross-package tests, and release automation. The shared repository is a development boundary only; it does not introduce a shared runtime package.

The normative contract declarations live in [spec/contracts](spec/contracts). The type-only package implementation lives in [packages/contracts](packages/contracts) and preserves stable subpath exports while keeping optional extension exports separate.

Runtime packages use TypeScript source in `src/index.ts`, publish standard ESM runtime as `dist/index.js`, and publish public package types as `dist/index.d.ts`.

All source code and packages are public and open source under the MIT license. Packages are independently versioned and published separately to GitHub Packages; npmjs publication is intentionally deferred. The consolidated release line starts at `0.1.0`.

## Implemented Packages

- `@authmodules/contracts`: [contracts](packages/contracts)
- `@authmodules/core`: [core](packages/core)
- `@authmodules/testkit`: [testkit](packages/testkit)
- `@authmodules/method-password`: [method-password](packages/method-password)
- `@authmodules/method-otp`: [method-otp](packages/method-otp)
- `@authmodules/store-postgres`: [store-postgres](packages/store-postgres)
- `@authmodules/crypto-node`: [crypto-node](packages/crypto-node)
- `@authmodules/token-opaque`: [token-opaque](packages/token-opaque)
- `@authmodules/carrier-cookie`: [carrier-cookie](packages/carrier-cookie)
- `@authmodules/delivery-email-smtp`: [delivery-email-smtp](packages/delivery-email-smtp)
- `@authmodules/effects-sync-delivery`: [effects-sync-delivery](packages/effects-sync-delivery)
- `@authmodules/effects-outbox`: [effects-outbox](packages/effects-outbox)
- `@authmodules/outbox-worker`: [outbox-worker](packages/outbox-worker)
- `@authmodules/guard-memory`: [guard-memory](packages/guard-memory)
- `@authmodules/framework-express`: [framework-express](packages/framework-express)

The outbox contract remains an optional extension of the stable contract surface. The official OTP production composition uses `effects-outbox` and `outbox-worker` so challenge persistence and required delivery enqueue remain atomic. Synchronous delivery is suitable for non-state-mutating effects and explicit development/test compositions.

## Local Checks

Use Node.js 24.11.0 or newer and npm 11.16.0. The codebase is checked with TypeScript 7. npm workspaces link the local packages from one atomic checkout.

```sh
npm ci
AUTHMODULES_POSTGRES_URL=postgres://... npm run check
```

Use a dedicated disposable PostgreSQL database: the integration suite resets AuthModules tables. The check validates the contract/spec mirror, repository boundaries, release manifests, cross-package authentication flows, coverage thresholds, generated declarations, public API snapshots, package entrypoints, and a clean consumer installation from locally packed tarballs. It does not publish, tag, or push anything.

Pull requests also run dependency review and CodeQL. Dependabot checks npm and GitHub Actions updates every week. Release Please creates a combined release PR only when the manual workflow is dispatched. Merging that PR publishes each changed workspace as its own GitHub Package, verifies the exact tarball integrity, creates provenance and CycloneDX SBOM attestations, and retains release evidence.

The GitHub repository configuration, GitHub Packages authentication, and audited first-release procedure are documented in [docs/08-REPOSITORY-SETTINGS.md](docs/08-REPOSITORY-SETTINGS.md).

## License

MIT
