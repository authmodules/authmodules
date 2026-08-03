# @authmodules/carrier-cookie

Secure HTTP cookie token carrier for AuthModules.

The carrier reads raw session tokens from a framework-neutral request view and creates declarative cookie mutations for login, refresh, logout, and session revocation responses.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/carrier-cookie @authmodules/contracts
```

## Usage

```ts
import { createCookieTokenCarrier } from '@authmodules/carrier-cookie'

const carrier = createCookieTokenCarrier({
  name: '__Host-am_session',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax'
})
```

The default cookie name is `am_session`; defaults are `Path=/`, `Secure`, `HttpOnly`, and `SameSite=Lax`.

## Security rules

- `SameSite=None` requires `Secure`.
- `__Secure-` names require `Secure`.
- `__Host-` names require `Secure`, `Path=/`, and no `Domain`.
- Cookie names, paths, domains, and token values are validated before mutations are produced.
- Token values must match the RFC cookie-octet grammar; whitespace, commas, quotes, backslashes, controls, and non-ASCII characters are rejected.
- Read tokens are wrapped as raw secrets and serialize as redacted values.

The package creates carrier instructions; a framework adapter is responsible for applying them to a real response. CSRF protection remains a host-application responsibility for cookie-authenticated state-changing requests.

## Requirements

- Node.js 24.11.0 or newer within Node.js 24
- Native ESM

## Development

```sh
npm run check
```

## License

MIT
