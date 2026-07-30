# @authmodules/contracts

TypeScript contracts shared by the AuthModules ecosystem.

Version 0.1.0 defines the public boundaries for authentication methods, stores, tokens, carriers, delivery, effects, guards, transactions, security values, errors, and public views. This package contains declarations only and has no runtime side effects.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/contracts
```

## Usage

Import types from focused subpaths so package boundaries stay visible:

```ts
import type { Auth, CreateAuthConfig } from '@authmodules/contracts/core'
import type { OutboxStore } from '@authmodules/contracts/extensions'
import type { AuthMethod } from '@authmodules/contracts/method'
import type { AuthStore } from '@authmodules/contracts/store'
import type { TokenFormat } from '@authmodules/contracts/token'
```

The `extensions` subpath contains optional durable outbox contracts used by outbox-aware stores, dispatchers, workers, and compliance suites.

The root export is available when several contract groups are needed together:

```ts
import type {
  AuthContext,
  AuthFailure,
  Result,
  SessionView
} from '@authmodules/contracts'
```

## Design guarantees

- Contracts are framework-independent and do not select a database, transport, or web framework.
- Tenant identity is explicit on every authentication boundary.
- Raw, protected, and sealed secret values have distinct types and persistence rules.
- Public views and errors do not expose credential material or raw tokens.
- Extension points use stable interfaces instead of implementation-specific classes.

`PrivateData` and `DeliveryData` are shallow objects by contract. Normalize complex provider payloads before passing them across these boundaries.

## Requirements

- TypeScript 5.9 or newer is recommended.
- Runtime packages in the ecosystem require Node.js 24 or newer and native ESM.

## Development

```sh
npm run check
```

## License

MIT
