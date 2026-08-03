# @authmodules/core

Framework-independent authentication orchestration for AuthModules.

The core composes method, store, token, policy, guard, effects, clock, and identifier ports. It owns authentication flow ordering and public error mapping without owning HTTP, SMTP, or database infrastructure.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/core @authmodules/contracts
```

## Usage

```ts
import { createAuth } from '@authmodules/core'

const configured = createAuth({
  clock,
  idGenerator,
  store,
  methods: {
    [passwordMethod.methodId]: passwordMethod,
    [otpMethod.methodId]: otpMethod
  },
  token,
  effects,
  guard,
  policy,
  session: {
    defaultTtlSeconds: 3600,
    maxTtlSeconds: 86400
  }
})

if (!configured.ok) {
  throw new Error('Invalid AuthModules configuration')
}

const auth = configured.value
```

`createAuth` validates the composition root and returns a `Result`; configuration errors are never deferred to the first request.

## Operations

The returned `Auth` interface exposes:

- `enroll` for creating a new account or linking a method to the authenticated actor account;
- `authenticate` for one-step methods such as passwords;
- `begin` and `complete` for challenge methods such as OTP;
- `getSession` and `revokeSession` for session lifecycle operations.

Every operation requires an explicit `tenantId`. Challenge completion reuses the stored binding, validates actor continuity, and consumes the challenge transactionally with account, identity, and session changes.

## Security model

- Authentication methods return proofs; core validates and applies them.
- Validated method input is snapshotted before asynchronous policy, store, or method execution; mutable or accessor-backed values cannot change after validation.
- Enrollment cannot attach credential material to an unrelated existing identity.
- Account actors may revoke only their own sessions. System actors may revoke any session in the tenant; unauthorized and missing targets remain non-enumerating no-ops.
- Session TTL configuration and per-request TTL values are positive safe integer seconds bounded to 100 years.
- Current method flows that persist auth, challenge, session, or required-effect state fail before persistence unless a transaction runner covers every declared scope.
- Required side effects participate in the operation transaction; best-effort effects run post-commit and are reported separately.
- A required side effect on an operation that writes auth state requires a store transaction; core rejects the operation before persistence when that transaction is unavailable.
- Public failures are intentionally less specific than internal diagnostic reasons.
- Events and hooks receive public, redacted data only.

Use a durable store and a distributed guard in multi-process production deployments.

## Requirements

- Node.js 24.11.0 or newer within Node.js 24
- Native ESM

## Development

```sh
npm run check
```

## License

MIT
