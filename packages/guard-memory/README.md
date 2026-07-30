# @authmodules/guard-memory

Bounded in-memory authentication attempt guard for AuthModules.

The guard tracks failed attempts per tenant, operation, method, and normalized identity lookup within a sliding window.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/guard-memory @authmodules/contracts
```

## Usage

```ts
import { createMemoryAttemptGuard } from '@authmodules/guard-memory'

const guard = createMemoryAttemptGuard({
  maxFailures: 5,
  windowSeconds: 60,
  retryAfterSeconds: 60,
  maxKeys: 10_000
})
```

Pass the returned guard to `createAuth({ guard })`.

## Behavior

- Failed attempts are counted only after method execution reports an attempt-counting failure.
- A successful attempt clears the corresponding key.
- Old timestamps are pruned and the key count is bounded.
- Denials use the public `RATE_LIMITED` hint with a bounded retry interval.
- Tenants and method identities are isolated in the internal key.

This guard is process-local and resets on restart. It does not coordinate multiple instances and must not be treated as production-grade distributed rate limiting. Use it for tests, development, single-process tools, or as an additional local safeguard behind a durable shared limiter.

## Requirements

- Node.js 24 or newer
- Native ESM

## Development

```sh
npm run check
```

## License

MIT
