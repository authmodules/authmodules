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

## Version 0.1.0

This repository contains the ecosystem-level architecture, normative contracts, documentation, cross-package authentication tests, and release verification. Runtime implementations live in sibling repositories rather than a shared runtime package.

The normative contract declarations live in [spec/contracts](spec/contracts). The type-only package implementation lives in the sibling [contracts](../contracts) repository and preserves stable subpath exports while keeping optional extension exports separate.

Runtime packages use TypeScript source in `src/index.ts`, publish standard ESM runtime as `dist/index.js`, and publish public package types as `dist/index.d.ts`.

All source repositories and released packages are intended to be public and open source under the MIT license. Version `0.1.0` packages are published to GitHub Packages; npmjs publication is intentionally deferred.

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

Use Node.js 24 or newer. Runtime repositories currently resolve the type-only contracts source from a sibling `../contracts` checkout, so keep the repositories as siblings when running package checks before the first contracts release.

```sh
AUTHMODULES_POSTGRES_URL=postgres://... npm run check
```

Use a dedicated disposable PostgreSQL database: the integration suite resets AuthModules tables. The check validates the contract/spec mirror, repository boundaries, release manifests, cross-package authentication flows, coverage thresholds, generated declarations, and a clean consumer installation from locally packed tarballs. It does not publish, tag, or push anything.

The planned GitHub repository configuration, GitHub Packages authentication, and first-release order are documented in [docs/08-REPOSITORY-SETTINGS.md](docs/08-REPOSITORY-SETTINGS.md).

## License

MIT
