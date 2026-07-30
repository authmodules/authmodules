# @authmodules/crypto-node

Node.js cryptography primitives and secret wrappers for AuthModules.

The package provides secure random generation, SHA-256 hashing, HMAC-SHA-256, timing-safe comparison, asynchronous PBKDF2 password hashing, and AES-256-GCM secret sealing.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/crypto-node @authmodules/contracts
```

## Usage

```ts
import {
  createNodeCryptoProvider,
  createNodePasswordHasher,
  createNodeSecretSealer,
  rawSecret
} from '@authmodules/crypto-node'

const crypto = createNodeCryptoProvider()
const passwordHasher = createNodePasswordHasher()
const sealer = createNodeSecretSealer({
  key: rawSecret(aes256Key),
  keyId: 'delivery-2026-01'
})
```

HMAC generation requires `framing: 'hmac-sha256.v2'`. The framing authenticates an explicit context-presence tag and fixed-width context/value lengths, so contextual and context-free inputs cannot alias. Persisted legacy values are accepted only through the explicit `verifyHmac()` legacy branch, which returns a v2 upgrade candidate after a successful match. Generation of new legacy values is not supported.

The PBKDF2-HMAC-SHA256 implementation enforces at least 600,000 iterations and a 32-byte derived key. Weaker stored hashes can still be verified and are upgraded after successful authentication.

`aes256Key` must contain exactly 32 random bytes and should come from a secret manager or equivalent protected configuration.

## Defaults

- Password hashes use PBKDF2-HMAC-SHA-256 with 600,000 iterations and a 32-byte derived key.
- HMAC uses mandatory length-prefixed `hmac-sha256.v2` framing.
- Secret sealing uses AES-256-GCM with a fresh nonce.
- Seal purpose and expiry are authenticated and must match during unseal.
- Random strings generated from custom alphabets use rejection sampling to avoid modulo bias.

## Secret handling

`rawSecret`, `protectedValue`, and `sealedValue` create wrappers with redacted JSON serialization. Reveal methods are intentionally limited to the boundary that needs the underlying value.

Do not log revealed values, reuse sealing keys for unrelated applications, or hard-code production keys. Rotate keys by assigning stable `keyId` values and retaining old keys while records still reference them.

## Requirements

- Node.js 24 or newer
- Native ESM

## Development

```sh
npm run check
```

## License

MIT
