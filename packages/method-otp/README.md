# @authmodules/method-otp

Challenge-based one-time password authentication for AuthModules.

The method generates a code, stores only an HMAC verifier, emits a required delivery side effect, and returns a verified identity proof after successful challenge completion.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/method-otp @authmodules/contracts @authmodules/crypto-node
```

## Usage

```ts
import { createNodeCryptoProvider, rawSecret } from '@authmodules/crypto-node'
import { createOtpMethod } from '@authmodules/method-otp'

const otp = createOtpMethod({
  methodId: 'otp.email',
  subjectKind: 'email',
  channel: 'email',
  templateId: 'auth.sign-in-code',
  crypto: createNodeCryptoProvider(),
  verificationKey: rawSecret(otpHmacKey),
  ttlSeconds: 300,
  maxAttempts: 5,
  codeLength: 6
})
```

`otpHmacKey` must contain at least 32 unpredictable bytes and should be loaded from protected configuration.

## Delivery binding

The default delivery target is the normalized identity subject. To map a canonical subject to another trusted destination, provide `resolveDeliveryTarget`. The resolver receives the normalized lookup and a decision-safe authentication context. `policyInput` is available, while observability-only `metadata` is intentionally excluded. Untrusted request fields are not accepted as a destination override.

## Behavior

- Codes use an unbiased configurable alphabet and exact configured length.
- Only an HMAC verifier is stored in challenge material. New challenges use `otp-hmac-sha256.v3`.
- In-flight challenges carrying the former `otp-hmac-sha256.v2` verifier are checked only through the explicit legacy HMAC path; no fallback is attempted for v3 values.
- Codes and verification keys remain raw secret values.
- Challenge expiry, maximum attempts, replay protection, actor binding, and transactional consumption are enforced by core and store contracts.
- Successful completion marks the identity verified at the authentication time.

OTP begin performs account-mode preflight, then writes the challenge and required delivery enqueue in one transaction. Account/identity resolution and an optional session happen during successful completion. Compose both phases with a transactional outbox that shares the auth-store transaction; synchronous external delivery cannot commit atomically with those writes.

## Requirements

- Node.js 24.11.0 or newer within Node.js 24
- Native ESM
- A `CryptoProvider` and a delivery-capable effects dispatcher

## Development

```sh
npm run check
```

## License

MIT
