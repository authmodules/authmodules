# @authmodules/testkit

Deterministic test utilities and compliance suites for AuthModules packages.

The package provides clocks, identifier generators, redacted secret factories, public-view assertions, memory stores, and reusable contract conformance cases.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install --save-dev @authmodules/testkit @authmodules/contracts
```

## Usage

```ts
import {
  complianceSuites,
  createMemoryAuthStore,
  deterministicIdGenerator,
  fixedClock,
  makeRawSecret
} from '@authmodules/testkit'

const clock = fixedClock('2026-01-01T00:00:00.000Z')
const ids = deterministicIdGenerator('example')
const store = createMemoryAuthStore()
const password = makeRawSecret('correct horse battery staple')

for (const complianceCase of complianceSuites.store.cases) {
  await complianceCase.run({ store })
}
```

Available suites cover core flows, stores, tokens, carriers, delivery transports, effects, guards, and outbox stores.

## Test-only components

- `createMemoryAuthStore` and `createMemoryOutboxStore` are deterministic in-process fakes.
- `createMemoryAuthOutboxStores` returns auth and outbox stores with one shared request-scoped transaction runner for atomic integration tests.
- `fixedClock` supports direct time control without timers.
- Secret helpers redact JSON and expose persistence methods only for the matching secret class.
- Public-view assertions fail when secret-bearing values cross a public boundary.
- `__unsafe*` fields exist only for precise test inspection.

Do not use the memory stores, deterministic identifiers, fixed clocks, or exposed internal maps in production. They do not provide durability, distributed concurrency, cryptographic randomness, or operational cleanup guarantees.

## Requirements

- Node.js 24 or newer
- Native ESM

## Development

```sh
npm run check
```

## License

MIT
