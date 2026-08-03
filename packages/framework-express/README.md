# @authmodules/framework-express

Small Express-compatible boundary adapter for AuthModules.

The adapter converts request-like objects into AuthModules context and carrier views, delegates session lookup, and applies declarative HTTP mutations to response-like objects. It is not an Express server, router, or middleware stack.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/framework-express @authmodules/contracts @authmodules/carrier-cookie
```

## Usage

```ts
import { createCookieTokenCarrier } from '@authmodules/carrier-cookie'
import { createExpressAuthAdapter } from '@authmodules/framework-express'

const adapter = createExpressAuthAdapter({
  auth,
  carrier: createCookieTokenCarrier(),
  tenantResolver(req) {
    return resolveTenantFromTrustedRoute(req)
  }
})

app.get('/session', async (req, res) => {
  const result = await adapter.getSession(req)
  res.status(result.ok ? 200 : 401).json(result.ok ? result.value : result.error.publicError)
})
```

When using a cookie carrier, the host must populate `req.cookies` with trusted cookie-parsing middleware or an equivalent request adapter. This package does not parse the raw `Cookie` header.

Use `applyHttpMutations` when an AuthModules result contains carrier instructions that must be written to the response.

## Trust boundaries

- `tenantResolver` is mandatory. Resolve tenants from trusted routing or server configuration, not an arbitrary client header.
- Inbound headers, cookies, context identifiers, actor data, and public metadata are validated and bounded.
- Populate `req.authActor` only from verified server-side session or authentication middleware. Never derive it directly from request bodies, headers, or cookies; shape validation does not establish identity.
- Header and cookie mutations reject injection and malformed scope attributes.
- Secret values are revealed only while writing the final HTTP response.

The host application still owns Helmet or equivalent security headers, CSRF protection, CORS, request body limits, trusted proxy configuration, rate limiting, authentication routes, and centralized error handling.

## Requirements

- Node.js 24.11.0 or newer within Node.js 24
- Native ESM
- Express or another framework exposing compatible request and response shapes

## Development

```sh
npm run check
```

## License

MIT
