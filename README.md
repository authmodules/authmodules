# AuthModules

AuthModules is an open-source TypeScript authentication ecosystem built from small independent packages.

The goal is simple: provide focused building blocks for authentication and identity without owning your application runtime.

## What It Is

- Domain-first auth building blocks.
- Small scoped packages published through GitHub Packages.
- Explicit ports and adapters.
- Independent repositories.
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

This repository contains the ecosystem-level architecture, normative contracts, documentation, cross-package authentication tests, and release verification. Runtime implementations live in sibling repositories rather than a shared runtime package.

The normative contract declarations live in [spec/contracts](spec/contracts). The type-only package implementation lives in the sibling [contracts](../contracts) repository and preserves stable subpath exports while keeping optional extension exports separate.

Runtime packages use TypeScript source in `src/index.ts`, publish standard ESM runtime as `dist/index.js`, and publish public package types as `dist/index.d.ts`.

All source repositories and released packages are public and open source under the MIT license. Packages are independently versioned and published to GitHub Packages; npmjs publication is intentionally deferred. The initial ecosystem release is `0.1.0`; independently changed packages and the central release coordination repository also have `0.1.1` releases.

## Implemented Packages

- `@authmodules/contracts`: [contracts](../contracts)
- `@authmodules/core`: [core](../core)
- `@authmodules/testkit`: [testkit](../testkit)
- `@authmodules/method-password`: [method-password](../method-password)
- `@authmodules/method-otp`: [method-otp](../method-otp)
- `@authmodules/store-postgres`: [store-postgres](../store-postgres)
- `@authmodules/crypto-node`: [crypto-node](../crypto-node)
- `@authmodules/token-opaque`: [token-opaque](../token-opaque)
- `@authmodules/carrier-cookie`: [carrier-cookie](../carrier-cookie)
- `@authmodules/delivery-email-smtp`: [delivery-email-smtp](../delivery-email-smtp)
- `@authmodules/effects-sync-delivery`: [effects-sync-delivery](../effects-sync-delivery)
- `@authmodules/effects-outbox`: [effects-outbox](../effects-outbox)
- `@authmodules/outbox-worker`: [outbox-worker](../outbox-worker)
- `@authmodules/guard-memory`: [guard-memory](../guard-memory)
- `@authmodules/framework-express`: [framework-express](../framework-express)

The outbox contract remains an optional extension of the stable contract surface. The official OTP production composition uses `effects-outbox` and `outbox-worker` so challenge persistence and required delivery enqueue remain atomic. Synchronous delivery is suitable for non-state-mutating effects and explicit development/test compositions.

## Local Checks

Use Node.js 24 or newer. The codebase is checked with TypeScript 7. Runtime repositories resolve the type-only contracts source from a sibling `../contracts` checkout during local development, so keep the repositories as siblings when running package checks.

```sh
AUTHMODULES_POSTGRES_URL=postgres://... npm run check
```

Use a dedicated disposable PostgreSQL database: the integration suite resets AuthModules tables. The check validates the contract/spec mirror, repository boundaries, release manifests, cross-package authentication flows, coverage thresholds, generated declarations, public API snapshots, package entrypoints, and a clean consumer installation from locally packed tarballs. It does not publish, tag, or push anything.

Pull requests also run dependency review and CodeQL. Dependabot checks npm and GitHub Actions updates every week. Future package release workflows publish the exact tarball verified by the immutable release plan, create provenance and CycloneDX SBOM attestations for that tarball, and retain the tarball and SBOM as workflow evidence.

The GitHub repository configuration, GitHub Packages authentication, and audited first-release procedure are documented in [docs/08-REPOSITORY-SETTINGS.md](docs/08-REPOSITORY-SETTINGS.md).

## License

MIT
