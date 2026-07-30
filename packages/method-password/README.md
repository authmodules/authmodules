# @authmodules/method-password

Password enrollment and authentication method for AuthModules.

The method normalizes identity subjects, delegates password hashing to an injected `PasswordHasher`, produces authentication proofs, and upgrades stored hashes when the configured hasher requires rehashing.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/method-password @authmodules/contracts @authmodules/crypto-node
```

## Usage

```ts
import { createNodePasswordHasher, rawSecret } from '@authmodules/crypto-node'
import { createPasswordMethod } from '@authmodules/method-password'

const password = createPasswordMethod({
  methodId: 'password.email',
  subjectKind: 'email',
  passwordHasher: createNodePasswordHasher(),
  minPasswordLength: 12,
  maxPasswordLength: 1024
})

const input = {
  subject: 'user@example.com',
  password: rawSecret('correct horse battery staple')
}
```

Register the returned method in `createAuth({ methods })` under its `methodId`.

## Behavior

- Email subjects are trimmed and lowercased before identity lookup.
- Passwords must be wrapped as raw secrets and are never included in proofs or public views.
- Enrollment creates password credential material but does not claim that an email address is verified.
- Authentication returns a medium-assurance, single-factor proof after password verification.
- Unknown identities and missing credentials perform dummy password-hash work before returning a generic authentication failure.
- A successful verification may return upgraded credential material for transactional replacement.

The default password length range is 8 to 1,024 characters. Product-specific password policy, breached-password checks, and recovery flows belong in the host application or dedicated extensions.

## Requirements

- Node.js 24 or newer
- Native ESM
- An implementation of the `PasswordHasher` contract

## Development

```sh
npm run check
```

## License

MIT
