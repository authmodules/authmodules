# @authmodules/token-opaque

Opaque session token format for AuthModules.

The package issues cryptographically random bearer tokens and persists only a versioned SHA-256 verifier through the injected `CryptoProvider`.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/token-opaque @authmodules/contracts @authmodules/crypto-node
```

## Usage

```ts
import { createNodeCryptoProvider } from '@authmodules/crypto-node'
import { createOpaqueTokenFormat } from '@authmodules/token-opaque'

const token = createOpaqueTokenFormat({
  crypto: createNodeCryptoProvider(),
  bytes: 32,
  scheme: 'opaque-token-sha256.v1'
})
```

Pass the returned format to `createAuth({ token })`.

## Security properties

- The default token contains 32 random bytes encoded as base64url.
- Token verification uses a stored hash; the raw bearer token is returned only at issuance and carrier boundaries.
- Presented tokens must match the exact configured base64url length and alphabet before hashing.
- Token schemes are explicit, versioned identifiers so migrations cannot silently reinterpret existing hashes.
- Malformed presented values are treated as anonymous token misses.

Opaque tokens are bearer credentials. Deliver them only over TLS, store them in secure carriers, and revoke server-side sessions when access should end.

## Requirements

- Node.js 24.11.0 or newer within Node.js 24
- Native ESM
- A cryptographically secure `CryptoProvider`

## Development

```sh
npm run check
```

## License

MIT
